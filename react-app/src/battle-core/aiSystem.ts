// aiSystem.ts
// 说明：AI 系统负责敌方的补牌/部署/策略决策（第一阶段：仅迁移现有的“简单自动部署一张单位牌”逻辑）。
// 目标：从 engine.ts 抽离敌方 AI，保持行为与日志完全一致。

import type { BattleCard, BattleState, UnitInstance, UnitTemplate } from './types'

export interface AISystemDeps {
  isCellOccupied: (grid: BattleState['grid'], rowIdx: number, colIdx: number) => boolean
  placeUnitOnGrid: (
    grid: BattleState['grid'],
    unitId: string,
    rowIdx: number,
    colIdx: number,
    template: UnitTemplate,
  ) => void
  applyDeployMorale: (state: BattleState, unit: UnitInstance, template: UnitTemplate) => BattleState
}

/**
 * 敌方简单自动部署一张单位牌（从手牌中选择第一张可负担的单位牌，并在部署区从右往左找空位）
 * 注意：这是从 engine.ts 原样迁移的逻辑（保持行为不变）。
 */
export function autoDeployEnemyUnit(state: BattleState, deps: AISystemDeps): BattleState {
  const { battlefield, battleCards, unitTemplates } = state.config
  const [deployStart, deployEnd] = battlefield.enemyDeployCols

  const enemyHand = state.enemy.hand
  if (enemyHand.length === 0) return state

  // 选择第一张可负担的单位牌
  let chosenIndex = -1
  let chosenTemplate: UnitTemplate | undefined
  let chosenBattleCard: BattleCard | undefined
  for (let i = 0; i < enemyHand.length; i++) {
    const cardId = enemyHand[i]
    const battleCard = battleCards.find((c) => c.id === cardId)
    if (!battleCard || !battleCard.unitTemplateId) continue
    const tpl = unitTemplates.find((u) => u.id === battleCard.unitTemplateId)
    if (!tpl) continue
    if (state.enemy.commandPoints >= tpl.cost) {
      chosenIndex = i
      chosenTemplate = tpl
      chosenBattleCard = battleCard
      break
    }
  }

  if (chosenIndex === -1 || !chosenTemplate) return state

  const centerRow = Math.floor(battlefield.rows / 2)
  const candidateRows = [centerRow - 1, centerRow, centerRow + 1].filter((r) => r >= 1 && r <= battlefield.rows)
  const rowIndex = state.turnNumber % candidateRows.length
  const targetRow = candidateRows[rowIndex]
  let targetCol = deployEnd

  const rowIdx = targetRow - 1
  let colIdx = targetCol - 1

  // 从右往左在部署区内寻找一个空格
  while (targetCol >= deployStart) {
    if (!deps.isCellOccupied(state.grid, rowIdx, colIdx)) break
    targetCol--
    colIdx--
  }

  if (targetCol < deployStart) return state

  const unitId = `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  let next: BattleState = {
    ...state,
    grid: state.grid.map((r) => r.map((c) => ({ ...c }))),
    enemy: {
      ...state.enemy,
      hand: [...state.enemy.hand],
      commandPoints: state.enemy.commandPoints - chosenTemplate.cost,
    },
    units: { ...state.units },
  }

  // 检查是否部署在基地列（基地部署跳过延迟）
  const isBaseDeployment = targetCol === battlefield.enemyBaseCol

  // 获取单位数据（优先使用战斗副本，否则使用模板基础值）
  const unitMaxHp = chosenBattleCard ? chosenBattleCard.maxHp : chosenTemplate.baseStats.hp
  const unitCurrentHp = chosenBattleCard ? chosenBattleCard.currentHp : unitMaxHp

  if (isBaseDeployment || chosenTemplate.deployDelayTurns === 0) {
    const newUnit: UnitInstance = {
      id: unitId,
      templateId: chosenTemplate.id,
      owner: 'enemy',
      row: targetRow,
      col: targetCol,
      currentHp: unitCurrentHp,
      maxHp: unitMaxHp,
      status: 'just_deployed',
      remainingDeployTurns: 0,
      remainingUndeployTurns: 0,
      cardId: chosenBattleCard?.id || null,
      buffs: [],
      deployMoraleValue: chosenTemplate.deployMoraleValue || 0,
      justDeployedThisTurn: true,
    }
    next = deps.applyDeployMorale(next, newUnit, chosenTemplate)
    deps.placeUnitOnGrid(next.grid, unitId, rowIdx, colIdx, chosenTemplate)
    next.units[unitId] = newUnit
  } else {
    const beaconId = `beacon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const deployBeacon: UnitInstance = {
      id: beaconId,
      templateId: chosenTemplate.id,
      owner: 'enemy',
      row: targetRow,
      col: targetCol,
      currentHp: unitCurrentHp,
      maxHp: unitMaxHp,
      status: 'in_deploy_queue',
      remainingDeployTurns: chosenTemplate.deployDelayTurns,
      remainingUndeployTurns: 0,
      cardId: null,
      buffs: [],
      isDeployBeacon: true,
      deployTargetCardId: chosenBattleCard?.id,
      deployTargetTemplateId: chosenTemplate.id,
      deployTargetSpace: chosenTemplate.space,
    }
    deps.placeUnitOnGrid(next.grid, beaconId, rowIdx, colIdx, chosenTemplate)
    next.units[beaconId] = deployBeacon
  }

  // 从手牌中移除已部署的卡牌
  next.enemy.hand.splice(chosenIndex, 1)
  return next
}

export function fillHandForEnemy(state: BattleState): BattleState {
  const rule = state.config.resourceRule
  const currentHandSize = state.enemy.hand.length

  const maxCardsToDraw = rule.handLimit - currentHandSize
  const cardsToDraw = Math.min(rule.drawPerTurn, maxCardsToDraw)

  if (cardsToDraw <= 0) {
    return {
      ...state,
      enemy: { ...state.enemy },
    }
  }

  const next: BattleState = {
    ...state,
    enemy: {
      ...state.enemy,
      hand: [...state.enemy.hand],
      deck: [...state.enemy.deck],
    },
  }

  for (let i = 0; i < cardsToDraw; i++) {
    if (next.enemy.deck.length > 0) {
      const newCard = next.enemy.deck.shift()!
      next.enemy.hand.push(newCard)
    } else {
      break
    }
  }

  return next
}


