import { produce, setAutoFreeze } from 'immer'
import {
  calculateDamageAgainstUnit as calculateDamageAgainstUnitExternal,
  getDamageTypeForTemplate as getDamageTypeForTemplateExternal,
} from './damageSystem'

// 重要说明：
// 当前引擎中仍有大量“看起来可变”的状态更新逻辑（直接修改 grid/units 等）。
// Immer 在开发模式下默认会对 produce 返回的对象做深度冻结（autoFreeze），
// 这会导致后续对同一份 state 的直接修改抛出
// “Cannot assign to read only property ... of object '[object Array]'” 之类的错误。
// 在我们尚未全量迁移到 Immer 写法之前，先全局关闭 autoFreeze，避免与现有可变逻辑冲突。
setAutoFreeze(false)
import type {
  BattleConfig,
  BattleState,
  BattlefieldGrid,
  CellLayers,
  Owner,
  PlayerBattleState,
  UnitInstance,
  UnitTemplate,
  CardInventory,
  BattleCard,
  BattleResult,
  TerrainCell,
  DamageType,
  AttackPatternConfig,
  BattleSnapshot,
  BattleLog,
  BattleLogEntry,
  LogEntryType,
  SpaceLayer,
  Base,
  SimplifiedDamageLogEntry,
  BattlePhase,
} from './types'

import { moveUnitsForward as moveUnitsForwardExternal } from './movementSystem'
import { autoDeployEnemyUnit as autoDeployEnemyUnitExternal, fillHandForEnemy as fillHandForEnemyExternal } from './aiSystem'
import { applyCourageAura as applyCourageAuraExternal } from './effectSystem'

export function createEmptyGrid(rows: number, cols: number): BattlefieldGrid {
  const grid: BattlefieldGrid = []
  for (let r = 0; r < rows; r++) {
    const row: CellLayers[] = []
    for (let c = 0; c < cols; c++) {
      row.push({
        groundUnitId: null,
        airUnitId: null,
        fullUnitId: null,
      })
    }
    grid.push(row)
  }
  return grid
}

function createDefaultTerrain(rows: number, cols: number): TerrainCell[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({
      type: 'plain',
      effects: { moveCost: 1, attackModifier: 1, damageTakenModifier: 1 },
    })),
  )
}

function normalizeTerrain(config: BattleConfig): TerrainCell[][] {
  const { rows, cols, terrain } = config.battlefield
  if (!terrain) return createDefaultTerrain(rows, cols)
  const grid = createDefaultTerrain(rows, cols)
  for (let r = 0; r < Math.min(rows, terrain.length); r += 1) {
    for (let c = 0; c < Math.min(cols, terrain[r].length); c += 1) {
      const cell = terrain[r][c]
      if (cell) {
        const effects = cell.effects ?? {}
        grid[r][c] = {
          type: cell.type ?? 'plain',
          effects: {
            ...effects, // 保留未来扩展字段
            moveCost: effects.moveCost ?? 1,
            moveBonus: effects.moveBonus ?? 0,
            attackModifier: effects.attackModifier ?? 1,
            damageTakenModifier: effects.damageTakenModifier ?? 1,
            blocksGround: effects.blocksGround ?? false,
            blocksAir: effects.blocksAir ?? false,
            blocksFull: effects.blocksFull ?? false,
            blocksBuilding: effects.blocksBuilding ?? false,
            blocksTitan: effects.blocksTitan ?? false,
          },
        }
      }
    }
  }
  return grid
}

function getTerrainCell(state: BattleState, row: number, col: number): TerrainCell {
  const rIdx = row - 1
  const cIdx = col - 1
  const fallback: TerrainCell = {
    type: 'plain',
    effects: { moveCost: 1, attackModifier: 1, damageTakenModifier: 1 },
  }
  return state.terrain?.[rIdx]?.[cIdx] ?? fallback
}

function isTerrainBlocked(cell: TerrainCell, space: SpaceLayer): boolean {
  const effects = cell.effects
  if (!effects) return false
  if (space === 'ground' && effects.blocksGround) return true
  if (space === 'air' && effects.blocksAir) return true
  if (space === 'full' && effects.blocksFull) return true
  return false
}

// 伤害计算管线已迁移至 damageSystem.ts（保持纯计算，避免在 engine.ts 维护两套逻辑）

/**
 * 应用伤害到单位并记录伤害历史
 */
function applyDamageToUnit(
  state: BattleState,
  attackerTemplate: UnitTemplate,
  attackerOwner: 'player' | 'enemy' | 'neutral',
  attackerRow: number,
  attackerCol: number,
  target: UnitInstance,
  options?: {
    damageType?: DamageType
    canCrit?: boolean
    forceCrit?: boolean
    splashFactor?: number
    skillMultiplier?: number
    ignoreMorale?: boolean
    wasSplash?: boolean
    attackerUnitId?: string | null
  },
): { damage: number; isCrit: boolean; updatedTarget: UnitInstance; updatedState: BattleState } {
  const targetHpBefore = target.currentHp
  const damageResult = calculateDamageAgainstUnitExternal(
    state,
    attackerTemplate,
    attackerOwner,
    attackerRow,
    attackerCol,
    target,
    options,
    {
      getTerrainCell,
      findTemplateById,
      getMoraleForOwner: (s, owner) =>
        owner === 'player' ? s.playerMorale : owner === 'enemy' ? s.enemyMorale : 100,
    },
  )

  // 计算新HP：确保在0到maxHp之间
  const newHp = Math.max(0, Math.min(target.maxHp, target.currentHp - damageResult.damage))
  const isDead = newHp <= 0

  const updatedTarget: UnitInstance = {
    ...target,
    currentHp: newHp,
    status: isDead ? 'dead' : target.status, // 如果HP为0，标记为死亡
    damageHistory: [
      ...(target.damageHistory || []),
      {
        turnNumber: state.turnNumber,
        sourceUnitId: options?.attackerUnitId ?? null,
        sourceTemplateId: attackerTemplate.id,
        damageType: options?.damageType ?? getDamageTypeForTemplateExternal(attackerTemplate),
        baseDamage: damageResult.baseDamage,
        effectiveAttack: damageResult.effectiveAttack,
        isCrit: damageResult.isCrit,
        damageMultiplier: damageResult.damageMultiplier,
        damageTakenMultiplier: damageResult.damageTakenMultiplier,
        finalDamage: damageResult.damage,
        wasSplash: options?.wasSplash ?? false,
        targetHpBefore,
        targetHpAfter: newHp,
      },
    ],
  }

  // 获取攻击者单位（用于记录Buff信息）
  const attackerUnit = options?.attackerUnitId ? state.units[options.attackerUnitId] : null
  const targetTemplate =
    findTemplateById(state.config, target.templateId) ??
    ({
      baseStats: { hp: target.maxHp, attack: 0, physRes: 0, magicRes: 0, moveSpeed: 0, range: 1 },
    } as UnitTemplate)

  // 记录伤害日志（包含完整的伤害管线信息）
  let nextState = addPendingLogEntry(
    state,
    options?.wasSplash ? 'unit_damaged' : 'unit_damaged',
    `${attackerTemplate.name}(${options?.attackerUnitId || 'unknown'}) 对 ${target.templateId}(${target.id}) 造成 ${damageResult.damage} 点${options?.damageType ?? getDamageTypeForTemplateExternal(attackerTemplate)}伤害${options?.wasSplash ? '（溅射）' : ''}${damageResult.isCrit ? '（暴击）' : ''}`,
    {
      attackerUnitId: options?.attackerUnitId,
      attackerTemplateId: attackerTemplate.id,
      attackerOwner,
      attackerPosition: { row: attackerRow, col: attackerCol },
      targetUnitId: target.id,
      targetTemplateId: target.templateId,
      targetPosition: { row: target.row, col: target.col },
      damageType: options?.damageType ?? getDamageTypeForTemplateExternal(attackerTemplate),
      // 完整的伤害管线信息（用于复现）
      damageCalculation: {
        baseAttack: attackerTemplate.baseStats.attack,
        effectiveAttack: Math.round(damageResult.effectiveAttack * 100) / 100,
        baseDamage: damageResult.baseDamage,
        isCrit: damageResult.isCrit,
        critMultiplier: damageResult.damageMultiplier,
        skillMultiplier: options?.skillMultiplier ?? 1.0,
        damageTakenMultiplier: damageResult.damageTakenMultiplier,
        finalDamage: damageResult.damage,
        wasSplash: options?.wasSplash ?? false,
        // 添加用于复现的完整上下文
        attackerMorale: options?.ignoreMorale ? 100 : (attackerOwner === 'player' ? state.playerMorale : attackerOwner === 'enemy' ? state.enemyMorale : 100),
        attackerTerrainMod: getTerrainCell(state, attackerRow, attackerCol)?.effects?.attackModifier ?? 1.0,
        attackerBuffs: attackerUnit?.buffs?.map(b => ({ type: b.type, magnitude: b.magnitude })) ?? [],
        splashFactor: options?.splashFactor,
        ignoreMorale: options?.ignoreMorale ?? false,
      },
      targetHpBefore,
      targetHpAfter: newHp,
      targetDefense: targetTemplate.baseStats.physRes,
      targetTerrainMod: getTerrainCell(state, target.row, target.col)?.effects?.damageTakenModifier ?? 1.0,
    },
  )

  // 如果单位死亡，记录死亡日志
  if (isDead) {
    nextState = addPendingLogEntry(
      nextState,
      'unit_killed',
      `${target.templateId}(${target.id}) 被 ${attackerTemplate.name}(${options?.attackerUnitId || 'unknown'}) 击杀`,
      {
        killedUnitId: target.id,
        killedTemplateId: target.templateId,
        killerUnitId: options?.attackerUnitId,
        killerTemplateId: attackerTemplate.id,
        finalHp: newHp,
      },
    )
  }

  return {
    damage: damageResult.damage,
    isCrit: damageResult.isCrit,
    updatedTarget,
    updatedState: nextState,
  }
}

function shuffle<T>(arr: T[]): T[] {
  const clone = [...arr]
  for (let i = clone.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[clone[i], clone[j]] = [clone[j], clone[i]]
  }
  return clone
}

function createPlayerState(config: BattleConfig): PlayerBattleState {
  // 使用战斗副本ID创建牌组
  const deck = shuffle([...config.playerDeck.cards])
  const hand = deck.splice(0, config.resourceRule.initialHandSize)
  return {
    deck,
    discardPile: [],
    hand,
    commandPoints: config.resourceRule.initialCommandPoints,
  }
}

function createEnemyState(config: BattleConfig): PlayerBattleState {
  const deck = shuffle(config.enemyDeck?.cards ?? [])
  const hand = deck.splice(0, config.resourceRule.initialHandSize)
  return {
    deck,
    discardPile: [],
    hand,
    commandPoints: config.resourceRule.initialCommandPoints,
  }
}

export function createInitialBattleState(config: BattleConfig): BattleState {
  const grid = createEmptyGrid(config.battlefield.rows, config.battlefield.cols)
  const terrain = normalizeTerrain(config)

  let player = createPlayerState(config)
  let enemy = createEnemyState(config)

  // Demo 专用：为 sampleBattleConfig 预设首回合测试用手牌，便于验证伤害与溅射逻辑
  if (config.id === 'demo-battle-1') {
    const playerArtilleryCards = config.battleCards.filter(
      (c) => c.unitTemplateId === 'imperium-artillery',
    )
    const playerInfantryCards = config.battleCards.filter(
      (c) => c.unitTemplateId === 'imperium-infantry',
    )

    const desiredHand: string[] = []
    if (playerArtilleryCards[0]) desiredHand.push(playerArtilleryCards[0].id)
    if (playerInfantryCards[0]) desiredHand.push(playerInfantryCards[0].id)
    if (playerInfantryCards[1]) desiredHand.push(playerInfantryCards[1].id)

    const usedPlayerIds = new Set(desiredHand)
    const remainingDeck = player.deck.filter((id) => !usedPlayerIds.has(id))

    if (desiredHand.length > 0) {
      player = {
        ...player,
        hand: desiredHand,
        deck: remainingDeck,
      }
    }

    const enemyOrkCards = config.battleCards.filter((c) => c.unitTemplateId === 'ork-boy')
    const enemyDesiredHand: string[] = []
    if (enemyOrkCards[0]) enemyDesiredHand.push(enemyOrkCards[0].id)
    if (enemyOrkCards[1]) enemyDesiredHand.push(enemyOrkCards[1].id)

    const usedEnemyIds = new Set(enemyDesiredHand)
    const enemyRemainingDeck = enemy.deck.filter((id) => !usedEnemyIds.has(id))

    if (enemyDesiredHand.length > 0) {
      enemy = {
        ...enemy,
        hand: enemyDesiredHand,
        deck: enemyRemainingDeck,
      }
    }
  }

  return {
    config,
    grid,
    terrain,
    playerBase: { ...config.playerBase },
    enemyBase: { ...config.enemyBase },
    units: {},
    player,
    enemy,
    playerMorale: config.initialPlayerMorale ?? 100, // 默认100
    enemyMorale: config.initialEnemyMorale ?? 100, // 默认100
    turnNumber: 1,
    phase: 'PlayerPlanning',
    winner: null,
    pendingEvents: [],
    pendingLogEntries: [], // 初始化待处理日志条目
  }
}

function getForwardDirectionForOwner(owner: 'player' | 'enemy', config: BattleConfig): 1 | -1 {
  const { playerBaseCol, enemyBaseCol } = config.battlefield
  const playerGoesRight = playerBaseCol < enemyBaseCol
  if (owner === 'player') {
    return playerGoesRight ? 1 : -1
  }
  return playerGoesRight ? -1 : 1
}

function isCellOccupied(grid: BattlefieldGrid, row: number, col: number): boolean {
  const cell = grid[row][col]
  return Boolean(cell.groundUnitId || cell.airUnitId || cell.fullUnitId)
}

function placeUnitOnGrid(
  grid: BattlefieldGrid,
  unitId: string,
  row: number,
  col: number,
  template: UnitTemplate,
): void {
  // 为了避免对可能被冻结/只读的格子或行对象直接赋值，这里显式创建新行和新 cell 再替换回去
  const oldRow = grid[row]
  const newRow = Array.isArray(oldRow) ? oldRow.slice() : [...oldRow]
  const oldCell = newRow[col]
  const cell = {
    ...oldCell,
  }
  if (template.space === 'ground') {
    cell.groundUnitId = unitId
  } else if (template.space === 'air') {
    cell.airUnitId = unitId
  } else {
    cell.fullUnitId = unitId
  }
  newRow[col] = cell
  grid[row] = newRow
}

function removeUnitFromGrid(grid: BattlefieldGrid, unitId: string): void {
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const oldCell = grid[r][c]
      if (
        oldCell.groundUnitId === unitId ||
        oldCell.airUnitId === unitId ||
        oldCell.fullUnitId === unitId
      ) {
        const cell = { ...oldCell }
        if (cell.groundUnitId === unitId) cell.groundUnitId = null
        if (cell.airUnitId === unitId) cell.airUnitId = null
        if (cell.fullUnitId === unitId) cell.fullUnitId = null
        grid[r][c] = cell
      }
    }
  }
}

function findTemplateById(config: BattleConfig, templateId: string): UnitTemplate | undefined {
  return config.unitTemplates.find((t) => t.id === templateId)
}

// ==================== 士气系统 ====================

// 说明：士气对攻击/暴击的数值影响已迁移至 damageSystem（保持单一来源）。

/**
 * 更新士气值（限制在0~120范围内）
 */
function updateMorale(state: BattleState, owner: 'player' | 'enemy', delta: number): BattleState {
  return produce(state, (draft) => {
    const currentMorale = owner === 'player' ? draft.playerMorale : draft.enemyMorale
    const newMorale = Math.max(0, Math.min(120, currentMorale + delta))

    if (owner === 'player') {
      draft.playerMorale = newMorale
    } else {
      draft.enemyMorale = newMorale
    }
  })
}

function toMoraleOwner(owner: Owner): 'player' | 'enemy' {
  return owner === 'enemy' ? 'enemy' : 'player'
}

/**
 * 单位部署完成时增加士气
 */
function applyDeployMorale(state: BattleState, unit: UnitInstance, template: UnitTemplate): BattleState {
  const moraleValue = template.deployMoraleValue || 0
  if (moraleValue > 0) {
    return updateMorale(state, toMoraleOwner(unit.owner), moraleValue)
  }
  return state
}

/**
 * 单位被击杀时扣除/增加士气
 */
function applyKillMorale(
  state: BattleState,
  killedUnit: UnitInstance,
  killedTemplate: UnitTemplate,
): BattleState {
  const moraleValue = killedUnit.deployMoraleValue || killedTemplate.deployMoraleValue || 0
  
  // 扣除己方士气：1.5倍部署士气值
  let next = updateMorale(state, toMoraleOwner(killedUnit.owner), -moraleValue * 1.5)
  
  // 给对方增加士气：0.5倍部署士气值
  const enemyOwner = killedUnit.owner === 'player' ? 'enemy' : 'player'
  next = updateMorale(next, enemyOwner, moraleValue * 0.5)
  
  return next
}

/**
 * 部署信标在单位成功落地前被摧毁时的额外士气惩罚
 * 规则：在正常阵亡士气变化之外，额外扣除 3 倍部署获得的士气值（仅施加给信标所属方）
 */
function applyDeployBeaconDestroyedMorale(
  state: BattleState,
  beaconUnit: UnitInstance,
  targetTemplate: UnitTemplate,
): BattleState {
  const moraleValue = beaconUnit.deployMoraleValue || targetTemplate.deployMoraleValue || 0
  if (moraleValue <= 0) {
    return state
  }

  const penalty = moraleValue * 3

  // 先应用士气变化
  let next = updateMorale(state, toMoraleOwner(beaconUnit.owner), -penalty)

  // 再记录一条详细日志，便于复盘
  next = addPendingLogEntry(
    next,
    'morale_changed',
    `${beaconUnit.templateId}(${beaconUnit.id}) 的部署信标在单位落地前被摧毁，额外损失士气 ${penalty}`,
    {
      unitId: beaconUnit.id,
      templateId: beaconUnit.templateId,
      owner: beaconUnit.owner,
      penalty,
      reason: 'deploy_beacon_destroyed_before_landing',
    },
  )

  return next
}

/**
 * 单位反部署时扣除士气
 */
/**
 * 基地受到攻击时快速降低士气
 * 这里按造成的伤害 * 0.5 递减（向下取整，至少1点），可根据关卡调节
 */
function applyBaseDamageMorale(
  state: BattleState,
  owner: 'player' | 'enemy',
  damage: number,
): BattleState {
  const moraleLoss = Math.max(1, Math.floor(damage * 0.5))
  return updateMorale(state, owner, -moraleLoss)
}

function applyCourageAura(state: BattleState, centerRow: number, centerCol: number): BattleState {
  return applyCourageAuraExternal(state, centerRow, centerCol, {
    updateMorale,
  })
}

export function deployPlayerUnit(state: BattleState, handIndex: number, row: number, col: number): BattleState {
  if (state.phase !== 'PlayerPlanning' || state.winner) return state

  const { battlefield, battleCards, unitTemplates } = state.config
  const [deployStart, deployEnd] = battlefield.playerDeployCols

  // 坐标与部署区域校验（逻辑使用 1-based 列号）
  if (col < deployStart || col > deployEnd) return state
  if (row < 1 || row > battlefield.rows) return state

  if (handIndex < 0 || handIndex >= state.player.hand.length) return state

  const battleCardId = state.player.hand[handIndex]

  const battleCard = battleCards.find((c) => c.id === battleCardId)
  if (!battleCard) {
    console.warn(`找不到战斗副本: ${battleCardId}`)
    return state
  }
  if (!battleCard.unitTemplateId) return state

  const template = unitTemplates.find((u) => u.id === battleCard.unitTemplateId)
  if (!template) return state

  if (state.player.commandPoints < template.cost) return state

  // 处理法术卡牌：法术卡牌不创建单位，直接触发效果
  if (template.type === 'spell') {
    let next: BattleState = {
      ...state,
      player: {
        ...state.player,
        hand: [...state.player.hand],
        commandPoints: state.player.commandPoints - template.cost,
      },
      units: { ...state.units },
    }

    // 从手牌中移除法术卡牌
    next.player.hand.splice(handIndex, 1)

    // 根据法术标签应用效果（数据驱动化：不再直接比较 template.id）
    if (template.tags?.includes('spell') && template.tags?.includes('buff')) {
      next = applyCourageAura(next, row, col)
    }

    return next
  }

  const rowIdx = row - 1
  const colIdx = col - 1

  if (isCellOccupied(state.grid, rowIdx, colIdx)) return state

  const unitId = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  let next: BattleState = {
    ...state,
    grid: state.grid.map((r) => r.map((c) => ({ ...c }))),
    player: {
      ...state.player,
      hand: [...state.player.hand],
      commandPoints: state.player.commandPoints - template.cost,
    },
    units: { ...state.units },
    config: {
      ...state.config,
      battleCards: [...state.config.battleCards],
    },
  }

  // 检查是否部署在基地列（基地部署跳过延迟）
  const isBaseDeployment = col === battlefield.playerBaseCol

  // 使用战斗副本中的卡牌数据
  const cardMaxHp = battleCard.maxHp
  const cardCurrentHp = battleCard.currentHp

  // 如果部署在基地列，跳过部署延迟，直接创建单位
  // 否则，如果有部署延迟，创建部署信标
  if (isBaseDeployment || template.deployDelayTurns === 0) {
    // 直接部署单位（基地部署或无需延迟）
    const newUnit: UnitInstance = {
      id: unitId,
      templateId: template.id,
      owner: 'player',
      row,
      col,
      currentHp: cardCurrentHp,
      maxHp: cardMaxHp,
      status: 'on_field',
      remainingDeployTurns: 0,
      remainingUndeployTurns: 0,
      cardId: battleCardId,
      buffs: [],
      deployMoraleValue: template.deployMoraleValue || 0, // 记录部署士气值
    }
    // 基地部署立即生效，立即应用士气
    next = applyDeployMorale(next, newUnit, template)
    placeUnitOnGrid(next.grid, unitId, rowIdx, colIdx, template)
    next.units[unitId] = newUnit
    // 记录部署日志
    next = addPendingLogEntry(
      next,
      'unit_deployed',
      `部署 ${template.name}(${unitId}) 在 (${row}, ${col})，消耗 ${template.cost} 指令点数`,
      {
        unitId,
        templateId: template.id,
        owner: 'player',
        row,
        col,
        cost: template.cost,
        deployDelay: 0,
        isBaseDeployment,
        cardId: battleCardId,
        initialHp: cardCurrentHp,
        maxHp: cardMaxHp,
      },
    )
  } else {
    // 创建部署信标
    const beaconId = `beacon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const deployBeacon: UnitInstance = {
      id: beaconId,
      templateId: template.id, // 使用目标单位的模板ID（用于显示）
      owner: 'player',
      row,
      col,
      // 信标继承被部署单位的生命值（可以被摧毁）
      currentHp: cardCurrentHp,
      maxHp: cardMaxHp,
      status: 'in_deploy_queue',
      remainingDeployTurns: template.deployDelayTurns,
      remainingUndeployTurns: 0,
      cardId: null, // 部署信标不关联卡牌
      buffs: [],
      isDeployBeacon: true,
      deployTargetCardId: battleCardId,
      deployTargetTemplateId: template.id,
      deployTargetSpace: template.space, // 继承部署对象的格子占据类型
    }
    // 部署信标占据格子（继承部署对象的 space 类型）
    placeUnitOnGrid(next.grid, beaconId, rowIdx, colIdx, template)
    next.units[beaconId] = deployBeacon
  }
  // 从手牌中移除已部署的卡牌
  next.player.hand.splice(handIndex, 1)

  return next
}

function autoDeployEnemyUnit(state: BattleState): BattleState {
  return autoDeployEnemyUnitExternal(state, {
    isCellOccupied,
    placeUnitOnGrid,
    applyDeployMorale,
  })
}

// 计算单位的移动优先级，用于排序
// 优先级越高，越先移动（这样可以避免后面的单位被前面的单位卡住）
// 对于标准前进模式：优先级 = 移动方向 * 当前位置
//   从左向右移动（dir=1）：优先级 = 1 * col，所以靠右的单位（col大）优先级更高，先移动
//   从右向左移动（dir=-1）：优先级 = -1 * col，所以靠左的单位（col小）优先级更高，先移动
function calculateMovePriority(
  unit: UnitInstance,
  template: UnitTemplate,
  config: BattleConfig,
): number {
  if (template.behavior.movePattern === 'no_move') {
    return -Infinity // 不移动的单位优先级最低
  }

  if (template.behavior.movePattern === 'standard_advance') {
    const dir = getForwardDirectionForOwner(unit.owner === 'neutral' ? 'player' : unit.owner, config)
    // 优先级 = 移动方向 * 当前位置
    // 这样在移动方向上更靠后的单位会先移动，避免阻塞
    // 对于从左向右（dir=1）：col大的单位先移动
    // 对于从右向左（dir=-1）：col小的单位先移动
    return dir * unit.col
  }

  // 对于自定义移动模式，可以根据具体情况计算优先级
  // 目前暂时返回0，表示按原始顺序处理
  if (template.behavior.movePattern === 'custom') {
    // TODO: 未来可以根据自定义移动的目标位置计算优先级
    return 0
  }

  return 0
}

// =============== 索敌 / 攻击范围相关辅助函数 ===============

// 根据攻击模板与目标模板，判断是否允许命中该“空间类型”
function canHitTargetByAttackConfig(
  attackConfig: AttackPatternConfig | undefined,
  targetTemplate: UnitTemplate,
): boolean {
  if (!attackConfig) return true

  const isBuilding = targetTemplate.type === 'building'
  const space = targetTemplate.space

  if (isBuilding) {
    if (attackConfig.canHitBuilding === false) return false
    return true
  }

  if (space === 'air') {
    // 默认不打空中单位，除非显式允许
    return attackConfig.canHitAir === true
  }

  // ground / full / 其他：只要没有显式禁止地面即可
  if (attackConfig.canHitGround === false) return false
  return true
}

interface AttackableTargetInfo {
  target: UnitInstance
  distance: number
}

// 使用格子模板计算可攻击单位（仅用于配置了 attackPatternConfig 的单位）
function getAttackableTargetsByPattern(
  state: BattleState,
  unit: UnitInstance,
  template: UnitTemplate,
  allUnitsArray: UnitInstance[],
): AttackableTargetInfo[] {
  const attackConfig = template.attackPatternConfig
  if (!attackConfig || !attackConfig.cells || attackConfig.cells.length === 0) return []

  const dir = getForwardDirectionForOwner(
    unit.owner === 'neutral' ? 'player' : unit.owner,
    state.config,
  )
  const { rows, cols } = state.config.battlefield

  const results: AttackableTargetInfo[] = []

  for (const cell of attackConfig.cells) {
    const targetRow = unit.row + cell.dr
    const targetCol = unit.col + dir * cell.dc
    if (targetRow < 1 || targetRow > rows || targetCol < 1 || targetCol > cols) continue

    for (const other of allUnitsArray) {
      if (other.id === unit.id) continue
      if (other.owner === unit.owner) continue
      if (other.status === 'dead') continue
      if (other.row !== targetRow || other.col !== targetCol) continue

      const otherTemplate = findTemplateById(state.config, other.templateId)
      if (!otherTemplate) continue
      if (!canHitTargetByAttackConfig(attackConfig, otherTemplate)) {
        // 调试日志：记录被过滤的目标
        console.log(`[索敌过滤] ${template.id} 无法攻击 ${otherTemplate.id} (空间类型: ${otherTemplate.space}, canHitAir: ${attackConfig.canHitAir}, canHitGround: ${attackConfig.canHitGround})`)
        continue
      }

      // 使用模板坐标的曼哈顿距离作为排序依据
      const distance = Math.abs(cell.dr) + Math.abs(cell.dc)
      results.push({ target: other, distance })
    }
  }

  return results
}

// 旧逻辑：同一行 + 前方 + range 内最近单位
function getAttackableTargetsLegacy(
  state: BattleState,
  unit: UnitInstance,
  template: UnitTemplate,
  allUnitsArray: UnitInstance[],
): AttackableTargetInfo[] {
  const dir = getForwardDirectionForOwner(
    unit.owner === 'neutral' ? 'player' : unit.owner,
    state.config,
  )
  const range = template.baseStats.range
  const results: AttackableTargetInfo[] = []

  for (const other of allUnitsArray) {
    if (other.id === unit.id) continue
    if (other.status === 'dead') continue
    if (other.owner === unit.owner) continue
    if (other.row !== unit.row) continue

    const otherTemplate = findTemplateById(state.config, other.templateId)
    if (!otherTemplate) continue

    // 检查攻击配置：旧逻辑也需要检查canHitAir等
    // 如果没有attackPatternConfig，使用默认值（默认可以打地面，不能打空中）
    const canHitAir = template.attackPatternConfig?.canHitAir ?? false
    const canHitGround = template.attackPatternConfig?.canHitGround ?? true
    
    if (otherTemplate.space === 'air' && canHitAir === false) {
      continue // 跳过空中单位
    }
    if (otherTemplate.space === 'ground' && canHitGround === false) {
      continue // 跳过地面单位（如果配置了只打空中）
    }

    const distance = Math.abs(other.col - unit.col)
    const forward = dir === 1 ? other.col > unit.col : other.col < unit.col
    if (!forward) continue
    if (distance > range) continue

    results.push({ target: other, distance })
  }

  return results
}

// 综合：根据是否配置 attackPatternConfig，选择使用新/旧逻辑
function getAttackableTargetsForUnit(
  state: BattleState,
  unit: UnitInstance,
  template: UnitTemplate,
  allUnitsArray: UnitInstance[],
): AttackableTargetInfo[] {
  if (template.attackPatternConfig) {
    return getAttackableTargetsByPattern(state, unit, template, allUnitsArray)
  }
  return getAttackableTargetsLegacy(state, unit, template, allUnitsArray)
}

function moveUnitsForward(state: BattleState): BattleState {
  return moveUnitsForwardExternal(state, {
    findTemplateById,
    calculateMovePriority,
    getForwardDirectionForOwner,
    getTerrainCell,
    isTerrainBlocked,
    isCellOccupied,
    removeUnitFromGrid,
    placeUnitOnGrid,
    addPendingLogEntry,
  })
}

function performAttacks(state: BattleState): BattleState {
  let next: BattleState = {
    ...state,
    units: { ...state.units },
    playerBase: { ...state.playerBase },
    enemyBase: { ...state.enemyBase },
  }

  const { battlefield } = state.config
  // 部署中、反部署中、在场上的单位都可以受到伤害
  const allUnitsArray = Object.values(state.units).filter(
    (u) => u.status === 'on_field' || u.status === 'in_deploy_queue' || u.status === 'undeploying',
  )
  // 只有在场上的单位才能攻击
  // 只有状态为 'on_field' 且不是刚部署的单位才能攻击
  const attackingUnitsArray = Object.values(state.units).filter((u) => {
    if (u.status !== 'on_field' || u.justDeployedThisTurn) return false
    const template = findTemplateById(state.config, u.templateId)
    if (!template) return false
    // 火炮类单位冷却机制：上一回合开火后，下一回合无法进行任何动作（攻击与移动）
    if (template.tags?.includes('requires_cooldown_after_attack') && typeof u.lastActedTurn === 'number') {
      // 若本回合号与最近一次行动回合号之差为 1，表示刚在上一回合行动过，需要冷却一回合
      if (state.turnNumber - u.lastActedTurn === 1) {
        return false
      }
    }
    return true
  })

  // 处理单位攻击（只有在场上的单位才能攻击）
  for (const unit of attackingUnitsArray) {
    const template = findTemplateById(state.config, unit.templateId)
    if (!template) continue
    if (template.baseStats.attack <= 0) continue

    const splashConfig = template.splashConfig

    // ===== 索敌与锁定目标 =====
    // 1）先基于当前攻击配置获取所有可攻击目标
    const attackableTargets = getAttackableTargetsForUnit(state, unit, template, allUnitsArray)

    // 2）若已有锁定目标且仍在可攻击列表中，则继续锁定该目标
    let bestTarget: UnitInstance | null = null
    if (unit.lockedTargetId) {
      const locked = attackableTargets.find((info) => info.target.id === unit.lockedTargetId)
      if (locked) {
        bestTarget = locked.target
      } else {
        // 锁定目标失效，清空锁定（写入到 next 中）
        const existing = next.units[unit.id]
        if (existing) {
          next.units[unit.id] = { ...existing, lockedTargetId: null }
        }
      }
    }

    // 3）如果没有有效锁定，则按照优先级重新选择目标
    //    当前规则通过 behavior.targetPriority 控制：
    //    - 默认（无配置或包含 prefer_units）：优先攻击非建筑单位，其次攻击建筑/障碍物，类别内按距离最近
    //    - prefer_buildings：建筑优先，其次攻击非建筑单位
    //    - buildings_only：仅攻击建筑（若范围内没有建筑则不攻击）
    if (!bestTarget && attackableTargets.length > 0) {
      const priorityRules = template.behavior.targetPriority ?? ['prefer_units']

      const isBuilding = (u: UnitInstance | undefined): boolean => {
        if (!u) return false
        const tpl = findTemplateById(state.config, u.templateId)
        return tpl?.type === 'building'
      }

      let candidates = [...attackableTargets]

      // buildings_only：只保留建筑目标
      if (priorityRules.includes('buildings_only')) {
        candidates = candidates.filter((info) => isBuilding(info.target))
      } else if (priorityRules.includes('prefer_buildings')) {
        // prefer_buildings：有建筑就只在建筑里选，否则回退到全部
        const buildingTargets = candidates.filter((info) => isBuilding(info.target))
        if (buildingTargets.length > 0) {
          candidates = buildingTargets
        }
      } else {
        // 默认 prefer_units：有单位就只在非建筑中选，否则回退到全部
        const nonBuildingTargets = candidates.filter((info) => !isBuilding(info.target))
        if (nonBuildingTargets.length > 0) {
          candidates = nonBuildingTargets
        }
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) => a.distance - b.distance)
        bestTarget = candidates[0].target
      }

      // 记录新的锁定目标
      const existing = next.units[unit.id]
      if (existing) {
        next.units[unit.id] = { ...existing, lockedTargetId: bestTarget ? bestTarget.id : null }
      }
    }

    if (bestTarget) {
      const targetTemplate = findTemplateById(state.config, bestTarget.templateId)
      if (!targetTemplate) continue

      // 记录攻击开始日志（包含索敌信息用于复现）
      next = addPendingLogEntry(
        next,
        'unit_attacked',
        `${template.name}(${unit.id}) 攻击 ${targetTemplate.name}(${bestTarget.id})`,
        {
          attackerUnitId: unit.id,
          attackerTemplateId: template.id,
          attackerOwner: unit.owner,
          attackerPosition: { row: unit.row, col: unit.col },
          targetUnitId: bestTarget.id,
          targetTemplateId: targetTemplate.id,
          targetOwner: bestTarget.owner,
          targetPosition: { row: bestTarget.row, col: bestTarget.col },
          attackPattern: template.attackPatternConfig ? 'pattern' : 'legacy',
          lockedTarget: unit.lockedTargetId === bestTarget.id,
          // 索敌信息（用于复现）
          targetSelection: {
            availableTargets: attackableTargets.length,
            priorityRules: template.behavior.targetPriority ?? ['prefer_units'],
            selectedTargetDistance: attackableTargets.find(t => t.target.id === bestTarget.id)?.distance,
            allCandidates: attackableTargets.map(t => ({
              targetId: t.target.id,
              templateId: t.target.templateId,
              distance: t.distance,
              position: { row: t.target.row, col: t.target.col },
            })),
          },
        },
      )

      // 计算对主目标的实际伤害（普通单位按正常暴击，部署信标强制暴击）
      const damageResult = applyDamageToUnit(
        next, // 使用更新后的状态（包含攻击日志）
        template,
        unit.owner === 'neutral' ? 'player' : unit.owner,
        unit.row,
        unit.col,
        next.units[bestTarget.id],
        {
          canCrit: true,
          forceCrit: Boolean(bestTarget.isDeployBeacon),
          attackerUnitId: unit.id,
        },
      )
      const updatedTarget = damageResult.updatedTarget
      next = damageResult.updatedState // 更新状态（包含伤害日志）

      // 如果单位已经死亡（在applyDamageToUnit中已设置status为dead），处理死亡逻辑
      if (updatedTarget.status === 'dead' || updatedTarget.currentHp <= 0) {
        // 确保状态和HP正确
        updatedTarget.status = 'dead'
        updatedTarget.currentHp = 0 // 确保HP为0，不超过上限
        next.units[bestTarget.id] = updatedTarget
        removeUnitFromGrid(next.grid, bestTarget.id)

        // 如果是部署信标死亡，则中止部署：视为被部署单位阵亡
        if (bestTarget.isDeployBeacon && bestTarget.deployTargetCardId) {
          const killedTemplateForBeacon =
            findTemplateById(state.config, bestTarget.deployTargetTemplateId || bestTarget.templateId) ||
            targetTemplate

          // 将对应的战斗卡牌生命值置为0，表示该单位死亡
          const battleCardIndex = next.config.battleCards.findIndex(
            (c) => c.id === bestTarget.deployTargetCardId,
          )
          if (battleCardIndex !== -1) {
            next.config.battleCards[battleCardIndex] = {
              ...next.config.battleCards[battleCardIndex],
              currentHp: 0,
            }
          }
          
          // 应用基础“单位阵亡”士气变化
          next = applyKillMorale(next, bestTarget, killedTemplateForBeacon)
          // 额外应用“部署信标在落地前被摧毁”的惩罚士气变化
          next = applyDeployBeaconDestroyedMorale(next, bestTarget, killedTemplateForBeacon)
        } else {
          // 单位被击杀，应用士气变化
          next = applyKillMorale(next, bestTarget, targetTemplate)
        }
      } else {
        next.units[bestTarget.id] = updatedTarget
      }

      // 帝国火炮攻击后记录行动回合，用于下一回合冷却（无法行动）
      if (template.tags?.includes('requires_cooldown_after_attack')) {
        const existing = next.units[unit.id]
        if (existing) {
          next.units[unit.id] = { ...existing, lastActedTurn: state.turnNumber }
        }
      }

      // ===== 溅射伤害（只能对主目标暴击，溅射部分不暴击） =====
      if (splashConfig && splashConfig.radius > 0 && splashConfig.coefficient > 0) {
        // 为了未来支持多格单位，这里按“每个实体汇总伤害”处理
        const splashDamageByUnitId: Record<string, number> = {}

        if (splashConfig.cells && splashConfig.cells.length > 0) {
          // 基于格子的溅射模板：相对主目标格的 dr/dc + 独立系数
          for (const cell of splashConfig.cells) {
            const targetRow = bestTarget.row + cell.dr
            const targetCol = bestTarget.col + cell.dc
            if (
              targetRow < 1 ||
              targetRow > battlefield.rows ||
              targetCol < 1 ||
              targetCol > battlefield.cols
            ) {
              continue
            }

            for (const other of allUnitsArray) {
              if (other.id === unit.id) continue // 不溅射到自己
              if (other.id === bestTarget.id) continue // 主目标已单独结算
              if (other.status === 'dead') continue
              if (other.row !== targetRow || other.col !== targetCol) continue

              // 友军是否允许被溅射
              if (other.owner === unit.owner && splashConfig.affectAllies !== true) continue

              const otherTemplate = findTemplateById(state.config, other.templateId)
              if (!otherTemplate) continue

              // 检查溅射目标类型：优先使用splashConfig中的配置，否则继承attackPatternConfig
              const canHitAir = splashConfig.canHitAir ?? template.attackPatternConfig?.canHitAir ?? true
              const canHitGround = splashConfig.canHitGround ?? template.attackPatternConfig?.canHitGround ?? true
              
              if (otherTemplate.space === 'air' && canHitAir === false) {
                continue // 跳过空中单位
              }
              if (otherTemplate.space === 'ground' && canHitGround === false) {
                continue // 跳过地面单位（如果配置了只打空中）
              }

              // 溅射部分：等效于"攻击减半后"的伤害计算，再乘以该格子的专属系数
              const splashDamageResult = applyDamageToUnit(
                next, // 使用更新后的状态
                template,
                unit.owner === 'neutral' ? 'player' : unit.owner,
                unit.row,
                unit.col,
                next.units[other.id],
                {
                  splashFactor: 0.5 * cell.coefficient,
                  canCrit: false,
                  forceCrit: Boolean(other.isDeployBeacon),
                  wasSplash: true,
                  attackerUnitId: unit.id,
                },
              )

              const effectiveSplashDamage = splashDamageResult.damage
              // 更新单位状态（包含伤害历史）
              next.units[other.id] = splashDamageResult.updatedTarget
              next = splashDamageResult.updatedState // 更新状态（包含日志）
              if (effectiveSplashDamage <= 0) continue

              splashDamageByUnitId[other.id] =
                (splashDamageByUnitId[other.id] ?? 0) + effectiveSplashDamage
            }
          }
        } else {
          // 旧逻辑：基于曼哈顿半径的十字/菱形溅射
          for (const other of allUnitsArray) {
            if (other.id === unit.id) continue // 不溅射到自己
            if (other.id === bestTarget.id) continue // 主目标已单独结算
            if (other.status === 'dead') continue

            // 友军是否允许被溅射
            if (other.owner === unit.owner && splashConfig.affectAllies !== true) continue

            const dist =
              Math.abs(other.row - bestTarget.row) + Math.abs(other.col - bestTarget.col)
            if (dist === 0 || dist > splashConfig.radius) continue

            const otherTemplate = findTemplateById(state.config, other.templateId)
            if (!otherTemplate) continue

            // 检查溅射目标类型：优先使用splashConfig中的配置，否则继承attackPatternConfig
            const canHitAir = splashConfig.canHitAir ?? template.attackPatternConfig?.canHitAir ?? true
            const canHitGround = splashConfig.canHitGround ?? template.attackPatternConfig?.canHitGround ?? true
            
            if (otherTemplate.space === 'air' && canHitAir === false) {
              continue // 跳过空中单位
            }
            if (otherTemplate.space === 'ground' && canHitGround === false) {
              continue // 跳过地面单位（如果配置了只打空中）
            }

            // 溅射部分：等效于"攻击减半后"的伤害计算
            // 默认不暴击；若目标为部署信标则强制暴击
            const splashDamageResult = applyDamageToUnit(
              next, // 使用更新后的状态
              template,
              unit.owner === 'neutral' ? 'player' : unit.owner,
              unit.row,
              unit.col,
              next.units[other.id],
              {
                splashFactor: 0.5 * splashConfig.coefficient,
                canCrit: false,
                forceCrit: Boolean(other.isDeployBeacon),
                wasSplash: true,
                attackerUnitId: unit.id,
              },
            )

            const effectiveSplashDamage = splashDamageResult.damage
            if (effectiveSplashDamage <= 0) continue

            // 更新单位状态（包含伤害历史）
            next.units[other.id] = splashDamageResult.updatedTarget
            next = splashDamageResult.updatedState // 更新状态（包含日志）
            splashDamageByUnitId[other.id] =
              (splashDamageByUnitId[other.id] ?? 0) + effectiveSplashDamage
          }
        }

        // 应用汇总后的溅射伤害，避免同一实体被多次结算击杀逻辑
        for (const [targetId, splashDamage] of Object.entries(splashDamageByUnitId)) {
          const currentTarget = next.units[targetId]
          if (!currentTarget || currentTarget.status === 'dead') continue

          const targetTemplateForSplash = findTemplateById(state.config, currentTarget.templateId)
          if (!targetTemplateForSplash) continue

          const updated: UnitInstance = {
            ...currentTarget,
            currentHp: currentTarget.currentHp - splashDamage,
          }

          if (updated.currentHp <= 0) {
            updated.status = 'dead'
            next.units[targetId] = updated
            removeUnitFromGrid(next.grid, targetId)
            // 溅射击杀同样触发士气变化；若目标为部署信标，则视为被部署单位阵亡
            if (currentTarget.isDeployBeacon && currentTarget.deployTargetCardId) {
              const killedTemplateForBeacon =
                findTemplateById(
                  state.config,
                  currentTarget.deployTargetTemplateId || currentTarget.templateId,
                ) || targetTemplateForSplash

              const battleCardIndex = next.config.battleCards.findIndex(
                (c) => c.id === currentTarget.deployTargetCardId,
              )
              if (battleCardIndex !== -1) {
                next.config.battleCards[battleCardIndex] = {
                  ...next.config.battleCards[battleCardIndex],
                  currentHp: 0,
                }
              }

              next = applyKillMorale(next, currentTarget, killedTemplateForBeacon)
            } else {
              next = applyKillMorale(next, currentTarget, targetTemplateForSplash)
            }
          } else {
            next.units[targetId] = updated
          }
        }
      }

      continue
    }

    // 若无可攻击单位，尝试攻击基地（同一行且在射程内，暂时仍然使用旧的 range 逻辑）
    const dir = getForwardDirectionForOwner(
      unit.owner === 'neutral' ? 'player' : unit.owner,
      state.config,
    )
    const range = template.baseStats.range
    if (unit.owner === 'player') {
      const distanceToBase = battlefield.enemyBaseCol - unit.col
      if (dir === 1 && distanceToBase > 0 && distanceToBase <= range) {
        // 使用统一伤害管线对敌方基地造成物理伤害（不考虑暴击）
        const baseDamageResult = calculateDamageAgainstUnitExternal(
          state,
          template,
          'player',
          unit.row,
          unit.col,
          {
            // 将基地视作具有0防御的单位模板占位
            id: 'enemy-base-unit',
            templateId: 'enemy-base-template',
            owner: 'enemy',
            row: unit.row,
            col: battlefield.enemyBaseCol,
            currentHp: next.enemyBase.hp,
            maxHp: next.enemyBase.maxHp,
            status: 'on_field',
            remainingDeployTurns: 0,
            remainingUndeployTurns: 0,
            cardId: null,
            buffs: [],
          } as UnitInstance,
          { canCrit: false },
          {
            getTerrainCell,
            findTemplateById,
            getMoraleForOwner: (s, owner) =>
              owner === 'player' ? s.playerMorale : owner === 'enemy' ? s.enemyMorale : 100,
          },
        )
        const inflicted = Math.min(baseDamageResult.damage, next.enemyBase.hp)
        next.enemyBase.hp = Math.max(0, next.enemyBase.hp - inflicted)
        next = applyBaseDamageMorale(next, 'enemy', inflicted)
      }
    } else if (unit.owner === 'enemy') {
      const distanceToBase = unit.col - battlefield.playerBaseCol
      if (dir === -1 && distanceToBase > 0 && distanceToBase <= range) {
        // 使用统一伤害管线对我方基地造成物理伤害（不考虑暴击）
        const baseDamageResult = calculateDamageAgainstUnitExternal(
          state,
          template,
          'enemy',
          unit.row,
          unit.col,
          {
            id: 'player-base-unit',
            templateId: 'player-base-template',
            owner: 'player',
            row: unit.row,
            col: battlefield.playerBaseCol,
            currentHp: next.playerBase.hp,
            maxHp: next.playerBase.maxHp,
            status: 'on_field',
            remainingDeployTurns: 0,
            remainingUndeployTurns: 0,
            cardId: null,
            buffs: [],
          } as UnitInstance,
          { canCrit: false },
          {
            getTerrainCell,
            findTemplateById,
            getMoraleForOwner: (s, owner) =>
              owner === 'player' ? s.playerMorale : owner === 'enemy' ? s.enemyMorale : 100,
          },
        )
        const inflicted = Math.min(baseDamageResult.damage, next.playerBase.hp)
        next.playerBase.hp = Math.max(0, next.playerBase.hp - inflicted)
        next = applyBaseDamageMorale(next, 'player', inflicted)
      }
    }
  }

  // ===== 基地反击：各自攻击射程内最近的敌方单位 =====
  const resolveBaseAttack = (
    base: Base,
    owner: 'player' | 'enemy',
    currentState: BattleState,
  ): BattleState => {
    const enemyOwner: 'player' | 'enemy' = owner === 'player' ? 'enemy' : 'player'
    const range = base.range
    const baseCol = base.column
    const maxTargets = Math.max(1, base.maxTargets ?? 1)

    // 只考虑在场或部署中的敌方单位
    const candidates = Object.values(currentState.units).filter(
      (u) =>
        u.owner === enemyOwner &&
        (u.status === 'on_field' || u.status === 'in_deploy_queue' || u.status === 'undeploying'),
    )

    const targetsWithDistance = candidates
      .map((u) => ({ unit: u, dist: Math.abs(u.col - baseCol) }))
      .filter(({ dist }) => dist > 0 && dist <= range)
      // 距离近优先；同距离下按 col 更靠近基地一侧，再按 row，最后按 id 保持稳定
      .sort((a, b) => {
        if (a.dist !== b.dist) return a.dist - b.dist
        if (a.unit.col !== b.unit.col) return Math.abs(a.unit.col - baseCol) - Math.abs(b.unit.col - baseCol)
        if (a.unit.row !== b.unit.row) return a.unit.row - b.unit.row
        return a.unit.id.localeCompare(b.unit.id)
      })
      .slice(0, maxTargets)

    if (targetsWithDistance.length === 0) return currentState

    let result: BattleState = currentState

    // 基地攻击使用统一伤害管线：不暴击、不受士气影响
    const baseTemplate: UnitTemplate = {
      // 将基地视作拥有基础攻击力的"单位模板"占位
      id: `${owner}-base-template`,
      name: `${owner === 'player' ? '玩家基地' : '敌方基地'}`,
      faction: owner === 'player' ? 'imperium' : 'ork',
      type: 'building',
      space: 'ground',
      cost: 0,
      baseStats: {
        hp: base.maxHp,
        attack: base.attack,
        physRes: 0,
        magicRes: 0,
        moveSpeed: 0,
        range: base.range,
      },
      tags: [],
      behavior: {
        movePattern: 'no_move',
        attackPattern: 'closest_in_row',
        targetFilter: 'enemy_only',
      },
      deployDelayTurns: 0,
      undeployDelayTurns: 0,
      deployMoraleValue: 0,
    }

    for (let i = 0; i < targetsWithDistance.length; i++) {
      const { unit: target, dist } = targetsWithDistance[i]
      const targetTemplate = findTemplateById(result.config, target.templateId)
      if (!targetTemplate) continue

      // 记录基地攻击日志（多目标：包含序号与最大目标数，便于复盘）
      result = addPendingLogEntry(
        result,
        'unit_attacked',
        `${owner === 'player' ? '玩家基地' : '敌方基地'} 攻击(${i + 1}/${targetsWithDistance.length}) ${targetTemplate.name}(${target.id})`,
        {
          attackerType: 'base',
          attackerOwner: owner,
          attackerPosition: { col: baseCol },
          maxTargets,
          attackIndex: i + 1,
          attackCount: targetsWithDistance.length,
          targetUnitId: target.id,
          targetTemplateId: targetTemplate.id,
          targetOwner: target.owner,
          targetPosition: { row: target.row, col: target.col },
          attackRange: range,
          targetDistance: dist,
          attackRangeType: 'column_only', // 只检查列距离
        },
      )

      const damageResult = applyDamageToUnit(
        result,
        baseTemplate,
        owner,
        Math.ceil(currentState.config.battlefield.rows / 2), // 基地假设在中间行
        baseCol,
        target,
        {
          canCrit: false,
          ignoreMorale: true,
          attackerUnitId: null, // 基地不是单位
        },
      )
      const updatedTarget = damageResult.updatedTarget
      result = damageResult.updatedState

      // 如果单位已经死亡，处理死亡逻辑（applyDamageToUnit已经处理了死亡日志）
      if (updatedTarget.status === 'dead' || updatedTarget.currentHp <= 0) {
        const finalTarget = { ...updatedTarget, status: 'dead' as const, currentHp: 0 }
        result.units[target.id] = finalTarget
        removeUnitFromGrid(result.grid, target.id)

        // 若目标是部署信标，视为被部署单位阵亡
        if (target.isDeployBeacon && target.deployTargetCardId) {
          const killedTemplateForBeacon =
            findTemplateById(
              result.config,
              target.deployTargetTemplateId || target.templateId,
            ) || targetTemplate

          const battleCardIndex = result.config.battleCards.findIndex(
            (c) => c.id === target.deployTargetCardId,
          )
          if (battleCardIndex !== -1) {
            result.config.battleCards[battleCardIndex] = {
              ...result.config.battleCards[battleCardIndex],
              currentHp: 0,
            }
          }

          result = applyKillMorale(result, target, killedTemplateForBeacon)
        } else {
          result = applyKillMorale(result, target, targetTemplate)
        }
      } else {
        result.units[target.id] = updatedTarget
      }
    }

    return result
  }

  // 敌我基地分别进行一次反击
  next = resolveBaseAttack(next.playerBase, 'player', next)
  next = resolveBaseAttack(next.enemyBase, 'enemy', next)

  return next
}

// 部署延迟结算：减少部署延迟回合数
// 注意：延迟为0的信标不会在这里转为单位，而是在下一回合开始时转换
function processDeployDelays(state: BattleState): BattleState {
  const next: BattleState = {
    ...state,
    units: { ...state.units },
  }

  for (const unitId in next.units) {
    const unit = next.units[unitId]
    if (unit.status === 'in_deploy_queue' && unit.remainingDeployTurns > 0) {
      const updatedUnit: UnitInstance = {
        ...unit,
        remainingDeployTurns: unit.remainingDeployTurns - 1,
      }
      next.units[unitId] = updatedUnit
    }
  }

  return next
}

// 将延迟为0的部署信标转为真正的单位（在回合开始时调用）
// 新部署的单位标记为"刚部署"，本回合不行动
function convertReadyBeaconsToUnits(state: BattleState): BattleState {
  let next: BattleState = {
    ...state,
    grid: state.grid.map((r) => r.map((c) => ({ ...c }))),
    units: { ...state.units },
    config: {
      ...state.config,
      battleCards: [...state.config.battleCards],
    },
  }

  const beaconsToReplace: string[] = []

  for (const unitId in next.units) {
    const unit = next.units[unitId]
    if (unit.status === 'in_deploy_queue' && unit.remainingDeployTurns === 0) {
      if (unit.isDeployBeacon && unit.deployTargetTemplateId) {
        // 部署信标：替换为真正的单位
        const template = findTemplateById(state.config, unit.deployTargetTemplateId)
        
        if (template) {
          // 尝试获取战斗副本（如果有）
          const battleCard = unit.deployTargetCardId
            ? state.config.battleCards.find((c) => c.id === unit.deployTargetCardId)
            : null

          // 从格子中移除部署信标
          removeUnitFromGrid(next.grid, unitId)
          beaconsToReplace.push(unitId)

          // 创建真正的单位（优先使用战斗副本数据，否则使用模板基础值）
          const realUnitId = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
          const realUnit: UnitInstance = {
            id: realUnitId,
            templateId: template.id,
            owner: unit.owner,
            row: unit.row,
            col: unit.col,
            currentHp: battleCard ? battleCard.currentHp : template.baseStats.hp,
            maxHp: battleCard ? battleCard.maxHp : template.baseStats.hp,
            status: 'just_deployed', // 标记为刚部署，本回合不行动
            remainingDeployTurns: 0,
            remainingUndeployTurns: 0,
            cardId: unit.deployTargetCardId || null,
            buffs: [],
            justDeployedThisTurn: true,
            deployMoraleValue: template.deployMoraleValue || 0, // 记录部署士气值
          }
          // 占据格子（使用部署信标继承的 space 类型）
          const rowIdx = unit.row - 1
          const colIdx = unit.col - 1
          placeUnitOnGrid(next.grid, realUnitId, rowIdx, colIdx, template)
          next.units[realUnitId] = realUnit
          // 部署完成，应用士气
          next = applyDeployMorale(next, realUnit, template)
        }
      } else {
        // 普通单位：直接改变状态，但标记为刚部署
        const template = findTemplateById(state.config, unit.templateId)
        const updatedUnit: UnitInstance = {
          ...unit,
          status: 'just_deployed',
          justDeployedThisTurn: true,
          deployMoraleValue: template?.deployMoraleValue || unit.deployMoraleValue || 0,
        }
        next.units[unitId] = updatedUnit
        // 部署完成，应用士气
        if (template) {
          next = applyDeployMorale(next, updatedUnit, template)
        }
      }
    }
  }

  // 移除已替换的部署信标
  // 注意：某些状态来源可能是“只读”或经过冻结/代理处理，直接 delete 属性可能触发运行时错误
  // 因此这里采用“重建 units 对象”的方式来排除这些信标，避免对原对象执行 delete 操作
  for (const beaconId of beaconsToReplace) {
    const beacon = next.units[beaconId]
    if (beacon) {
      // 记录部署信标被替换的日志
      next = addPendingLogEntry(
        next,
        'unit_undeployed',
        `部署信标 ${beacon.templateId}(${beaconId}) 已转换为单位`,
        {
          beaconId,
          templateId: beacon.templateId,
          reason: 'beacon_converted',
        },
      )
    }
  }

  if (beaconsToReplace.length > 0) {
    const beaconIdSet = new Set(beaconsToReplace)
    const newUnits: typeof next.units = {}
    for (const unitId in next.units) {
      if (!beaconIdSet.has(unitId)) {
        newUnits[unitId] = next.units[unitId]
      }
    }
    next.units = newUnits
  }

  return next
}

// 清除"刚部署"标记，让单位可以正常行动
function clearJustDeployedFlags(state: BattleState): BattleState {
  const next: BattleState = {
    ...state,
    units: { ...state.units },
  }

  for (const unitId in next.units) {
    const unit = next.units[unitId]
    if (unit.status === 'just_deployed') {
      const updatedUnit: UnitInstance = {
        ...unit,
        status: 'on_field',
        justDeployedThisTurn: false,
      }
      next.units[unitId] = updatedUnit
    }
  }

  return next
}

// 反部署结算：减少反部署延迟回合数，延迟为0时返回牌堆并更新卡牌损耗
function processUndeployDelays(state: BattleState): BattleState {
  let next: BattleState = {
    ...state,
    units: { ...state.units },
    player: { ...state.player },
    config: {
      ...state.config,
      battleCards: [...state.config.battleCards],
    },
  }

  const unitsToRemove: string[] = []

  for (const unitId in next.units) {
    const unit = next.units[unitId]
    if (unit.status === 'undeploying' && unit.remainingUndeployTurns > 0) {
      const updatedUnit: UnitInstance = {
        ...unit,
        remainingUndeployTurns: unit.remainingUndeployTurns - 1,
      }
      if (updatedUnit.remainingUndeployTurns === 0) {
        // 反部署完成，返回牌堆
        if (unit.cardId && unit.owner === 'player') {
          // 计算损耗：根据反部署时的生命值比例，降低最大生命值
          const hpRatio = unit.currentHp / unit.maxHp
          const template = findTemplateById(state.config, unit.templateId)
          if (template) {
            // 损耗计算：如果生命值低于50%，降低最大生命值
            const newMaxHp = Math.max(
              Math.floor(template.baseStats.hp * 0.5), // 最低保留50%最大生命值
              Math.floor(unit.maxHp * hpRatio), // 根据当前生命值比例计算
            )

            // 更新战斗副本中的卡牌信息
            const battleCardIndex = next.config.battleCards.findIndex((c) => c.id === unit.cardId)
            if (battleCardIndex !== -1) {
              next.config.battleCards[battleCardIndex] = {
                ...next.config.battleCards[battleCardIndex],
                maxHp: newMaxHp,
                currentHp: newMaxHp, // 反部署后补满生命值
              }
            }

            // 将卡牌放回牌堆（不是手牌）
            next.player.deck.push(unit.cardId)
          }
        }
        unitsToRemove.push(unitId)
      } else {
        next.units[unitId] = updatedUnit
      }
    }
  }

  // 移除已完成反部署的单位
  for (const unitId of unitsToRemove) {
    const unit = next.units[unitId]
    if (unit) {
      // 记录单位反部署完成的日志
      next = addPendingLogEntry(
        next,
        'unit_undeployed',
        `${unit.templateId}(${unitId}) 完成反部署，已从战场移除`,
        {
          unitId,
          templateId: unit.templateId,
          owner: unit.owner,
          reason: 'undeploy_completed',
        },
      )
    }
    removeUnitFromGrid(next.grid, unitId)
    delete next.units[unitId]
  }

  return next
}

// 反部署函数：让单位进入反部署状态，如果已经在反部署状态则取消反部署
export function undeployUnit(state: BattleState, unitId: string): BattleState {
  if (state.phase !== 'PlayerPlanning' || state.winner) return state

  const unit = state.units[unitId]
  if (!unit) return state
  if (unit.owner !== 'player') return state // 只能反部署我方单位
  if (unit.status !== 'on_field' && unit.status !== 'undeploying') return state // 只能反部署在场上的单位或正在反部署的单位
  if (!unit.cardId) return state // 必须有关联的卡牌

  const template = findTemplateById(state.config, unit.templateId)
  if (!template) return state

  const next: BattleState = {
    ...state,
    units: { ...state.units },
  }

  // 如果已经在反部署状态，则取消反部署
  if (unit.status === 'undeploying') {
    const updatedUnit: UnitInstance = {
      ...unit,
      status: 'on_field',
      remainingUndeployTurns: 0, // 清除反部署延迟
    }
    next.units[unitId] = updatedUnit
    return next
  }

  // 否则，进入反部署状态
  const updatedUnit: UnitInstance = {
    ...unit,
    status: 'undeploying',
    remainingUndeployTurns: template.undeployDelayTurns,
  }

  next.units[unitId] = updatedUnit

  return next
}


// 补牌逻辑：根据 ResourceRule.drawPerTurn 控制每回合补牌数量
// 补牌数量受手牌上限限制，不会超过 handLimit
// 注意：此函数必须基于输入 state 的当前手牌数量计算，确保幂等性
function fillHandForPlayer(state: BattleState): BattleState {
  const rule = state.config.resourceRule
  const currentHandSize = state.player.hand.length // 基于输入 state，不是 next
  
  // 根据 drawPerTurn 配置补牌，但不超过手牌上限
  const maxCardsToDraw = rule.handLimit - currentHandSize
  
  // 严格限制：每回合最多补 drawPerTurn 张，且不超过手牌上限
  const cardsToDraw = Math.min(rule.drawPerTurn, maxCardsToDraw)

  console.log(`[补牌] 当前手牌数: ${currentHandSize}, 手牌上限: ${rule.handLimit}, 每回合抽牌: ${rule.drawPerTurn}, 需要补牌: ${cardsToDraw}, 牌堆剩余: ${state.player.deck.length}`)

  // 如果不需要补牌，直接返回
  if (cardsToDraw <= 0) {
    console.log(`[补牌] 不需要补牌（手牌已满或已达上限）`)
    return {
      ...state,
      player: {
        ...state.player,
        hand: [...state.player.hand], // 确保返回新数组
        deck: [...state.player.deck], // 确保返回新数组
      },
    }
  }

  // 创建新状态并补牌
  const next: BattleState = {
    ...state,
    player: {
      ...state.player,
      hand: [...state.player.hand], // 明确创建新数组
      deck: [...state.player.deck], // 明确创建新数组，避免修改原数组
    },
  }

  // 补 cardsToDraw 张牌（从牌堆中抽取）
  let actuallyDrawn = 0
  for (let i = 0; i < cardsToDraw; i++) {
    if (next.player.deck.length > 0) {
      const newCard = next.player.deck.shift()!
      next.player.hand.push(newCard)
      actuallyDrawn++
    } else {
      // 牌堆空了，无法补牌
      console.log(`[补牌] 牌堆已空，无法继续补牌（已补 ${actuallyDrawn} 张）`)
      break
    }
  }

  console.log(`[补牌] 实际补牌数: ${actuallyDrawn}, 补牌后手牌数: ${next.player.hand.length}`)
  return next
}

function fillHandForEnemy(state: BattleState): BattleState {
  return fillHandForEnemyExternal(state)
}

function checkVictory(state: BattleState): BattleState {
  if (state.winner) return state

  let winner: BattleState['winner'] = null
  if (state.enemyBase.hp <= 0 && state.playerBase.hp > 0) {
    winner = 'player'
  } else if (state.playerBase.hp <= 0 && state.enemyBase.hp > 0) {
    winner = 'enemy'
  }

  if (!winner) return state

  return {
    ...state,
    winner,
    phase: 'Finished',
  }
}

// 很简化的"结束本回合"逻辑：推进单位、回复命令点并增加回合数
export function endPlayerPlanningPhase(state: BattleState): BattleState {
  if (state.phase !== 'PlayerPlanning' || state.winner) return state

  console.log(`[回合开始] 回合 ${state.turnNumber}, 阶段: ${state.phase}`)
  console.log(`[回合开始] 补牌前状态 - 手牌数: ${state.player.hand.length}, 牌堆数: ${state.player.deck.length}, 手牌: [${state.player.hand.join(', ')}]`)

  // 回合开始：先补牌（如果手牌未满）
  // 注意：补牌数量由 resourceRule.drawPerTurn 控制
  // 确保基于原始 state 的手牌数量计算，避免重复补牌
  const playerHandBefore = state.player.hand.length
  
  // 先调用补牌函数，它会创建新的状态（包括深拷贝 hand 和 deck）
  console.log(`[回合开始] 准备调用 fillHandForPlayer`)
  let next = fillHandForPlayer(state)
  console.log(`[回合开始] fillHandForPlayer 返回后 - 手牌数: ${next.player.hand.length}, 牌堆数: ${next.player.deck.length}, 手牌: [${next.player.hand.join(', ')}]`)
  
  // 然后确保其他状态也被正确初始化
  // 注意：player 已经在 fillHandForPlayer 中被正确处理（包括深拷贝 hand 和 deck），不要重新赋值
  next = {
    ...next,
    config: {
      ...next.config,
      battleCards: [...next.config.battleCards], // 确保 battleCards 数组也被复制
    },
    // player 已经在 fillHandForPlayer 中被正确处理，不需要重新赋值
    enemy: {
      ...next.enemy,
      hand: [...next.enemy.hand], // 确保 hand 数组被复制
      deck: [...next.enemy.deck], // 确保 deck 数组被复制
    },
  }
  console.log(`[回合开始] 初始化其他状态后 - 手牌数: ${next.player.hand.length}, 牌堆数: ${next.player.deck.length}, 手牌: [${next.player.hand.join(', ')}]`)
  
  const playerHandAfter = next.player.hand.length
  const cardsDrawn = playerHandAfter - playerHandBefore
  
  console.log(`[回合流程] 回合 ${state.turnNumber}: 补牌前手牌 ${playerHandBefore} -> 补牌后手牌 ${playerHandAfter} (补了 ${cardsDrawn} 张)`)
  
  // 调试：如果应该补牌但没有补，输出错误信息
  if (cardsDrawn === 0 && playerHandBefore < state.config.resourceRule.handLimit && state.player.deck.length > 0) {
    console.error(`[补牌异常] 应该补牌但没有补！手牌数: ${playerHandBefore}, 上限: ${state.config.resourceRule.handLimit}, 牌堆: ${state.player.deck.length}, 每回合抽: ${state.config.resourceRule.drawPerTurn}`)
  }
  
  // 调试：如果补牌数量异常，会在控制台输出
  if (cardsDrawn > state.config.resourceRule.drawPerTurn) {
    console.warn(
      `补牌异常：补了 ${cardsDrawn} 张，但配置为 ${state.config.resourceRule.drawPerTurn} 张。` +
      `回合 ${state.turnNumber}，手牌从 ${playerHandBefore} 变成 ${playerHandAfter}`
    )
  }
  
  next = fillHandForEnemy(next)

  // 回复命令点数（确保不覆盖 player 的其他属性）
  const rule = state.config.resourceRule
  next = {
    ...next,
    player: {
      ...next.player,
      commandPoints: Math.min(
        rule.maxCommandPoints,
        state.player.commandPoints + rule.commandPointsPerTurn,
      ),
    },
  }
  next = {
    ...next,
    enemy: {
      ...next.enemy,
      commandPoints: Math.min(
        rule.maxCommandPoints,
        state.enemy.commandPoints + rule.commandPointsPerTurn,
      ),
    },
  }

  // 先处理部署延迟（减少延迟回合数）
  next = processDeployDelays(next)
  next = processUndeployDelays(next)

  // 然后将延迟为0的部署信标转为单位（标记为刚部署，本回合不行动）
  next = convertReadyBeaconsToUnits(next)

  // 敌方简单自动部署一张单位牌
  next = autoDeployEnemyUnit(next)

  // 单位执行攻击（刚部署的单位不攻击）
  next = performAttacks(next)

  // 单位向前移动一格（刚部署的单位不移动）
  next = moveUnitsForward(next)

  // 回合结束：清除"刚部署"标记，让这些单位下一回合可以行动
  next = clearJustDeployedFlags(next)

  next.turnNumber = state.turnNumber + 1

  next = checkVictory(next)
  if (!next.winner) {
    next.phase = 'PlayerPlanning'
  }

  return next
}

// 占位：未来在这里实现完整的回合结算
export function resolveTurn(state: BattleState): BattleState {
  return state
}

export function listUnitsOnGrid(state: BattleState): UnitInstance[] {
  return Object.values(state.units)
}

// ========== 战斗副本系统 ==========

/**
 * 从背包卡牌创建战斗副本
 * @param inventoryCards 背包中的原始卡牌数据
 * @returns 战斗中的卡牌副本数组
 */
/**
 * 从背包卡牌创建战斗副本
 * @param inventoryCards 背包中的卡牌列表
 * @param unitTemplates 单位模板列表（用于生成显示名称）
 * @returns 战斗副本列表
 */
export function createBattleCardsFromInventory(
  inventoryCards: CardInventory[],
  unitTemplates?: UnitTemplate[],
): BattleCard[] {
  return inventoryCards
    .filter((card) => card.status !== 'killed') // 只创建可用卡牌的副本
    .map((inventoryCard) => {
      // 如果没有显示名称，尝试生成一个
      let displayName = inventoryCard.displayName
      if (!displayName && unitTemplates && inventoryCard.unitTemplateId) {
        const template = unitTemplates.find((t) => t.id === inventoryCard.unitTemplateId)
        if (template) {
          // MVP版本：简单命名（基础名称 + 序号）
          const index = inventoryCards.filter((c) => c.unitTemplateId === inventoryCard.unitTemplateId).indexOf(inventoryCard) + 1
          displayName = `${template.name} #${index}`
        }
      }
      
      return {
        id: `battle-${inventoryCard.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, // 战斗中的唯一ID
        sourceCardId: inventoryCard.id, // 指向原始卡牌
        type: inventoryCard.type,
        unitTemplateId: inventoryCard.unitTemplateId,
        maxHp: inventoryCard.maxHp, // 初始时等于原始值
        currentHp: inventoryCard.currentHp, // 初始时等于原始值
        displayName, // 复制显示名称
      }
    })
}

/**
 * 战斗结算：将战斗副本的修改合并回背包
 * @param battleState 战斗结束时的状态
 * @param inventoryCards 背包中的原始卡牌数据（用于对比）
 * @returns 战斗结算结果，包含需要更新回背包的卡牌数据
 */
export function calculateBattleResult(
  battleState: BattleState,
  inventoryCards: CardInventory[],
): BattleResult {
  const updatedCards: CardInventory[] = []
  const killedCardIds: string[] = []

  // 遍历战斗中的所有卡牌副本
  for (const battleCard of battleState.config.battleCards) {
    // 找到对应的原始卡牌
    const originalCard = inventoryCards.find((c) => c.id === battleCard.sourceCardId)
    if (!originalCard) continue

    // 检查是否阵亡（当前生命值 <= 0）
    const isKilled = battleCard.currentHp <= 0

    // 检查是否有修改（损耗、属性变化等）
    const hasChanges =
      battleCard.maxHp !== originalCard.maxHp ||
      battleCard.currentHp !== originalCard.currentHp ||
      isKilled

    if (hasChanges) {
      // 创建更新后的卡牌数据
      const updatedCard: CardInventory = {
        ...originalCard,
        maxHp: battleCard.maxHp, // 使用战斗后的最大生命值
        currentHp: battleCard.currentHp, // 使用战斗后的当前生命值
        status: isKilled ? 'killed' : originalCard.status || 'available', // 更新状态
      }
      updatedCards.push(updatedCard)

      if (isKilled) {
        killedCardIds.push(originalCard.id)
      }
    }
  }

  // 检查未部署的卡牌（在牌堆或手牌中但未部署的）
  // 这些卡牌虽然没有参与战斗，但可能需要更新状态
  // MVP版本：暂时不处理未部署的卡牌

  return {
    battleId: battleState.config.id,
    winner: battleState.winner,
    updatedCards,
    killedCardIds, // 新增：阵亡卡牌ID列表
  }
}

// ===== 调试函数 =====

/**
 * 调试：在指定位置添加一个单位（从模板创建）
 */
export function debugAddUnit(
  state: BattleState,
  templateId: string,
  owner: 'player' | 'enemy',
  row: number,
  col: number,
): BattleState {
  const template = findTemplateById(state.config, templateId)
  if (!template) {
    console.warn(`[调试] 找不到模板: ${templateId}`)
    return state
  }

  const { rows, cols } = state.config.battlefield
  if (row < 1 || row > rows || col < 1 || col > cols) {
    console.warn(`[调试] 坐标超出范围: (${row}, ${col})`)
    return state
  }

  const rowIdx = row - 1
  const colIdx = col - 1
  if (isCellOccupied(state.grid, rowIdx, colIdx)) {
    console.warn(`[调试] 位置已被占据: (${row}, ${col})`)
    return state
  }

  const unitId = `debug-u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const newUnit: UnitInstance = {
    id: unitId,
    templateId: template.id,
    owner,
    row,
    col,
    currentHp: template.baseStats.hp,
    maxHp: template.baseStats.hp,
    status: 'on_field',
    remainingDeployTurns: 0,
    remainingUndeployTurns: 0,
    cardId: null,
    buffs: [],
    damageHistory: [],
  }

  let next: BattleState = {
    ...state,
    grid: state.grid.map((r) => r.map((c) => ({ ...c }))),
    units: { ...state.units },
  }

  placeUnitOnGrid(next.grid, unitId, rowIdx, colIdx, template)
  next.units[unitId] = newUnit

  console.log(`[调试] 添加单位: ${template.name} (${owner}) 在 (${row}, ${col})`)
  return next
}

/**
 * 调试：删除指定单位
 */
export function debugRemoveUnit(state: BattleState, unitId: string): BattleState {
  const unit = state.units[unitId]
  if (!unit) {
    console.warn(`[调试] 找不到单位: ${unitId}`)
    return state
  }

  let next: BattleState = {
    ...state,
    grid: state.grid.map((r) => r.map((c) => ({ ...c }))),
    units: { ...state.units },
  }

  removeUnitFromGrid(next.grid, unitId)
  delete next.units[unitId]

  // 记录调试删除单位的日志
  next = addPendingLogEntry(
    next,
    'debug',
    `[调试] 删除单位: ${unit.templateId}(${unitId})`,
    {
      unitId,
      templateId: unit.templateId,
      owner: unit.owner,
      reason: 'debug_remove',
    },
  )

  console.log(`[调试] 删除单位: ${unitId}`)
  return next
}

/**
 * 调试：从手牌或牌堆部署单位（不消耗命令点数）
 * @param sourceType 'hand' 或 'deck'
 * @param sourceIndex 手牌索引或牌堆索引
 * @param row 部署行
 * @param col 部署列
 */
export function debugDeployUnit(
  state: BattleState,
  sourceType: 'hand' | 'deck',
  sourceIndex: number,
  row: number,
  col: number,
): BattleState {
  const { battlefield, battleCards, unitTemplates } = state.config
  const [deployStart, deployEnd] = battlefield.playerDeployCols

  // 坐标与部署区域校验
  if (col < deployStart || col > deployEnd) {
    console.warn(`[调试] 部署列超出范围: ${col}`)
    return state
  }
  if (row < 1 || row > battlefield.rows) {
    console.warn(`[调试] 部署行超出范围: ${row}`)
    return state
  }

  // 获取卡牌
  let battleCardId: string | null = null
  if (sourceType === 'hand') {
    if (sourceIndex < 0 || sourceIndex >= state.player.hand.length) {
      console.warn(`[调试] 手牌索引无效: ${sourceIndex}`)
      return state
    }
    battleCardId = state.player.hand[sourceIndex]
  } else {
    // 从牌堆
    if (sourceIndex < 0 || sourceIndex >= state.player.deck.length) {
      console.warn(`[调试] 牌堆索引无效: ${sourceIndex}`)
      return state
    }
    battleCardId = state.player.deck[sourceIndex]
  }

  const battleCard = battleCards.find((c) => c.id === battleCardId)
  if (!battleCard || !battleCard.unitTemplateId) {
    console.warn(`[调试] 找不到战斗卡牌或模板ID`)
    return state
  }

  const template = unitTemplates.find((u) => u.id === battleCard.unitTemplateId)
  if (!template) {
    console.warn(`[调试] 找不到模板: ${battleCard.unitTemplateId}`)
    return state
  }

  // 法术卡牌不支持调试部署
  if (template.type === 'spell') {
    console.warn(`[调试] 法术卡牌不支持调试部署`)
    return state
  }

  const rowIdx = row - 1
  const colIdx = col - 1
  if (isCellOccupied(state.grid, rowIdx, colIdx)) {
    console.warn(`[调试] 位置已被占据: (${row}, ${col})`)
    return state
  }

  const unitId = `debug-u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  let next: BattleState = {
    ...state,
    grid: state.grid.map((r) => r.map((c) => ({ ...c }))),
    player: {
      ...state.player,
      hand: [...state.player.hand],
      deck: [...state.player.deck],
    },
    units: { ...state.units },
  }

  // 从手牌或牌堆移除卡牌
  if (sourceType === 'hand') {
    next.player.hand.splice(sourceIndex, 1)
  } else {
    next.player.deck.splice(sourceIndex, 1)
  }

  // 检查是否部署在基地列（基地部署跳过延迟）
  const isBaseDeployment = col === battlefield.playerBaseCol

  // 如果部署在基地列，跳过部署延迟，直接创建单位
  // 否则，如果有部署延迟，创建部署信标
  if (isBaseDeployment || template.deployDelayTurns === 0) {
    // 直接部署单位（基地部署或无需延迟）
    const newUnit: UnitInstance = {
      id: unitId,
      templateId: template.id,
      owner: 'player',
      row,
      col,
      currentHp: battleCard.currentHp,
      maxHp: battleCard.maxHp,
      status: 'just_deployed', // 标记为刚部署，本回合不行动
      remainingDeployTurns: 0,
      remainingUndeployTurns: 0,
      cardId: battleCardId,
      buffs: [],
      deployMoraleValue: template.deployMoraleValue || 0,
      justDeployedThisTurn: true,
      damageHistory: [],
    }
    // 基地部署立即生效，立即应用士气
    next = applyDeployMorale(next, newUnit, template)
    placeUnitOnGrid(next.grid, unitId, rowIdx, colIdx, template)
    next.units[unitId] = newUnit
  } else {
    // 创建部署信标
    const beaconId = `debug-beacon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const deployBeacon: UnitInstance = {
      id: beaconId,
      templateId: template.id,
      owner: 'player',
      row,
      col,
      currentHp: battleCard.currentHp,
      maxHp: battleCard.maxHp,
      status: 'in_deploy_queue',
      remainingDeployTurns: template.deployDelayTurns,
      remainingUndeployTurns: 0,
      cardId: null,
      buffs: [],
      isDeployBeacon: true,
      deployTargetCardId: battleCardId,
      deployTargetTemplateId: template.id,
      deployTargetSpace: template.space,
      damageHistory: [],
    }
    placeUnitOnGrid(next.grid, beaconId, rowIdx, colIdx, template)
    next.units[beaconId] = deployBeacon
  }

  console.log(`[调试] 部署单位: ${template.name} 在 (${row}, ${col})，来源: ${sourceType}`)
  return next
}

/**
 * 调试：增加命令点数
 */
export function debugAddCommandPoints(
  state: BattleState,
  owner: 'player' | 'enemy',
  amount: number,
): BattleState {
  const current = owner === 'player' ? state.player.commandPoints : state.enemy.commandPoints
  const max = state.config.resourceRule.maxCommandPoints
  const newAmount = Math.min(max, current + amount)

  return {
    ...state,
    player: owner === 'player' ? { ...state.player, commandPoints: newAmount } : state.player,
    enemy: owner === 'enemy' ? { ...state.enemy, commandPoints: newAmount } : state.enemy,
  }
}

/**
 * 调试：向手牌添加卡牌
 */
export function debugAddCardToHand(
  state: BattleState,
  owner: 'player' | 'enemy',
  battleCardId: string,
): BattleState {
  const battleCard = state.config.battleCards.find((c) => c.id === battleCardId)
  if (!battleCard) {
    console.warn(`[调试] 找不到战斗卡牌: ${battleCardId}`)
    return state
  }

  const handLimit = state.config.resourceRule.handLimit
  const currentHand = owner === 'player' ? state.player.hand : state.enemy.hand
  if (currentHand.length >= handLimit) {
    console.warn(`[调试] 手牌已满`)
    return state
  }

  return {
    ...state,
    player:
      owner === 'player'
        ? { ...state.player, hand: [...state.player.hand, battleCardId] }
        : state.player,
    enemy:
      owner === 'enemy' ? { ...state.enemy, hand: [...state.enemy.hand, battleCardId] } : state.enemy,
  }
}

// ==================== 快照与日志系统 ====================

/**
 * 导出战斗快照
 * 注意：只保存原始数据，不保存计算后的值
 * - 保存：单位的基础属性（templateId、owner、坐标、状态等）
 * - 保存：单位的当前状态（currentHp、maxHp、buffs、skillCooldowns等）
 * - 不保存：计算后的值（damageHistory中的effectiveAttack、baseDamage、damageMultiplier等）
 *   这些值会在恢复后通过实时计算得到
 * @param state 当前战斗状态
 * @param description 可选的描述信息
 * @returns 快照对象
 */
export function exportBattleSnapshot(state: BattleState, description?: string): BattleSnapshot {
  // 清理计算后的数据，只保留原始数据
  const cleanedState: BattleState = {
    ...state,
    units: Object.fromEntries(
      Object.entries(state.units).map(([id, unit]) => [
        id,
        {
          ...unit,
          // 移除伤害历史中的计算值，只保留基本信息（用于调试，但不包含计算过程）
          // 如果需要完全移除damageHistory，可以设置为 undefined
          damageHistory: unit.damageHistory?.map((entry) => {
            // 只保存原始数据，不保存计算值
            const simplified: SimplifiedDamageLogEntry = {
              turnNumber: entry.turnNumber,
              sourceUnitId: entry.sourceUnitId,
              sourceTemplateId: entry.sourceTemplateId,
              damageType: entry.damageType,
              finalDamage: entry.finalDamage, // 最终伤害是结果数据，保留
              wasSplash: entry.wasSplash,
              targetHpBefore: entry.targetHpBefore, // HP变化是状态数据，保留
              targetHpAfter: entry.targetHpAfter,
              // 不保存计算过程：effectiveAttack, baseDamage, damageMultiplier, damageTakenMultiplier, isCrit
              // 这些值可以在恢复后通过实时计算得到
            }
            return simplified as any // 临时类型转换，因为UnitInstance中的damageHistory类型是DamageLogEntry[]
          }),
        },
      ]),
    ),
  }

  return {
    version: '1.0.0', // 快照版本号
    timestamp: Date.now(),
    turnNumber: state.turnNumber,
    phase: state.phase,
    battleState: JSON.parse(JSON.stringify(cleanedState)), // 深拷贝状态
    description,
  }
}

/**
 * 恢复战斗快照
 * @param snapshot 快照对象
 * @returns 恢复的战斗状态
 */
export function restoreBattleSnapshot(snapshot: BattleSnapshot): BattleState {
  // 验证快照版本（未来可以用于兼容性检查）
  if (snapshot.version !== '1.0.0') {
    console.warn(`[快照] 版本不匹配: 快照版本 ${snapshot.version}, 当前支持 1.0.0`)
  }

  // 手动编辑快照时很容易破坏规则：这里做一次轻量校验，失败时给出明确错误
  const validation = validateBattleSnapshot(snapshot)
  if (!validation.ok) {
    throw new Error(`[快照] 校验失败：\n- ${validation.errors.join('\n- ')}`)
  }

  // 直接返回快照中的状态（已经是深拷贝）
  // 注意：恢复后的状态中，damageHistory 不包含计算值，这些值会在需要时实时计算
  return snapshot.battleState
}

/**
 * 快照校验（用于“快照当测试用例”场景）
 * 目标：尽早发现“同名/重复ID、引用不一致、占格冲突”等问题，避免加载后出现隐蔽Bug。
 */
export function validateBattleSnapshot(
  snapshot: BattleSnapshot,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const state = snapshot.battleState

  if (!state?.config) {
    return { ok: false, errors: ['battleState/config 缺失'] }
  }

  const rows = state.config.battlefield.rows
  const cols = state.config.battlefield.cols

  // 1) battleCards：id 唯一，且 deck/hand 引用必须存在
  const battleCardIds = state.config.battleCards.map((c) => c.id)
  const battleCardIdSet = new Set(battleCardIds)
  if (battleCardIdSet.size !== battleCardIds.length) {
    errors.push('battleCards 中存在重复的 card.id（同名卡牌/重复ID）')
  }

  const allDeckRefs = [
    ...state.player.hand,
    ...state.player.deck,
    ...state.enemy.hand,
    ...state.enemy.deck,
    ...state.player.discardPile,
    ...state.enemy.discardPile,
  ]
  for (const ref of allDeckRefs) {
    if (!battleCardIdSet.has(ref)) {
      errors.push(`牌组引用了不存在的 battleCardId：${ref}`)
    }
  }

  // 2) unitTemplates：id 唯一；battleCards.unitTemplateId 必须存在（单位卡）
  const tplIds = state.config.unitTemplates.map((t) => t.id)
  const tplIdSet = new Set(tplIds)
  if (tplIdSet.size !== tplIds.length) {
    errors.push('unitTemplates 中存在重复的 template.id')
  }
  for (const c of state.config.battleCards) {
    if (c.type === 'unit') {
      if (!c.unitTemplateId) errors.push(`单位卡 battleCard(${c.id}) 缺少 unitTemplateId`)
      else if (!tplIdSet.has(c.unitTemplateId)) {
        errors.push(`battleCard(${c.id}) 引用了不存在的 unitTemplateId：${c.unitTemplateId}`)
      }
    }
  }

  // 3) units：id 唯一；坐标合法；templateId 必须存在；grid 占格一致性（同格同层不能重复）
  const unitIds = Object.keys(state.units)
  const unitIdSet = new Set(unitIds)
  if (unitIdSet.size !== unitIds.length) {
    errors.push('units 中存在重复的 unitId key（对象键异常）')
  }

  // 同格同层占用检测（由 units 的 row/col 推导）
  const occupancy = new Map<string, string>() // `${r},${c},${space}` -> unitId
  for (const u of Object.values(state.units)) {
    if (u.row < 0 || u.row >= rows || u.col < 0 || u.col >= cols) {
      errors.push(`unit(${u.id}) 坐标越界：(${u.row},${u.col})`)
      continue
    }
    if (!tplIdSet.has(u.templateId)) {
      errors.push(`unit(${u.id}) 引用了不存在的 templateId：${u.templateId}`)
    }

    // 若有关联卡牌，则要求该 battleCard 存在
    if (u.cardId && !battleCardIdSet.has(u.cardId)) {
      errors.push(`unit(${u.id}) 的 cardId 不存在于 battleCards：${u.cardId}`)
    }

    const tpl = state.config.unitTemplates.find((t) => t.id === u.templateId)
    const space = (tpl?.space ?? u.deployTargetSpace ?? 'ground') as string
    const key = `${u.row},${u.col},${space}`
    const existed = occupancy.get(key)
    if (existed) {
      errors.push(`同一格同一层重复占用：(${u.row},${u.col}) layer=${space} units=${existed},${u.id}`)
    } else {
      occupancy.set(key, u.id)
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/**
 * 创建日志条目
 */
function createLogEntry(
  turnNumber: number,
  phase: BattlePhase,
  type: LogEntryType,
  message: string,
  data?: Record<string, any>,
): BattleLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now(),
    turnNumber,
    phase,
    type,
    message,
    data,
  }
}

/**
 * 向BattleState添加待处理日志条目
 * 这些日志条目会在UI层统一处理并添加到BattleLog
 */
function addPendingLogEntry(
  state: BattleState,
  type: LogEntryType,
  message: string,
  data?: Record<string, any>,
): BattleState {
  const entry = createLogEntry(state.turnNumber, state.phase, type, message, data)
  return {
    ...state,
    pendingLogEntries: [...(state.pendingLogEntries || []), entry],
  }
}

/**
 * 添加日志条目
 */
export function addBattleLogEntry(
  log: BattleLog,
  turnNumber: number,
  phase: BattlePhase,
  type: LogEntryType,
  message: string,
  data?: Record<string, any>,
): BattleLog {
  const entry = createLogEntry(turnNumber, phase, type, message, data)
  const maxEntries = log.maxEntries ?? 1000

  return {
    ...log,
    entries: [...log.entries, entry].slice(-maxEntries), // 保持最大条目数
  }
}

/**
 * 导出日志为文本
 */
export function exportBattleLogAsText(log: BattleLog): string {
  const lines: string[] = []
  lines.push('=== 战斗日志 ===')
  lines.push(`总条目数: ${log.entries.length}`)
  lines.push('')

  for (const entry of log.entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN')
    lines.push(`[回合 ${entry.turnNumber}] [${entry.phase}] [${entry.type}] ${time}`)
    lines.push(`  ${entry.message}`)
    if (entry.data && Object.keys(entry.data).length > 0) {
      lines.push(`  数据: ${JSON.stringify(entry.data, null, 2)}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 导出日志为JSON
 */
export function exportBattleLogAsJSON(log: BattleLog): string {
  return JSON.stringify(log, null, 2)
}


