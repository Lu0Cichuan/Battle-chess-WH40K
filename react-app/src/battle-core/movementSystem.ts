// movementSystem.ts
// 说明：移动系统负责单位移动与阻挡规则（不负责伤害与回合流程）。
// 本文件的第一阶段目标：从 engine.ts 迁移 `moveUnitsForward`，确保行为与日志字段完全一致。

import type { BattleConfig, BattleState, TerrainCell, UnitInstance, UnitTemplate } from './types'

export interface MovementSystemDeps {
  findTemplateById: (config: any, templateId: string) => UnitTemplate | undefined
  calculateMovePriority: (unit: UnitInstance, template: UnitTemplate, config: BattleConfig) => number
  getForwardDirectionForOwner: (owner: 'player' | 'enemy', config: BattleConfig) => 1 | -1
  getTerrainCell: (state: BattleState, row: number, col: number) => TerrainCell
  isTerrainBlocked: (cell: TerrainCell, space: UnitTemplate['space']) => boolean
  isCellOccupied: (grid: BattleState['grid'], rowIdx: number, colIdx: number) => boolean
  removeUnitFromGrid: (grid: BattleState['grid'], unitId: string) => void
  placeUnitOnGrid: (
    grid: BattleState['grid'],
    unitId: string,
    rowIdx: number,
    colIdx: number,
    template: UnitTemplate,
  ) => void
  addPendingLogEntry: (
    state: BattleState,
    type: any,
    message: string,
    payload?: any,
  ) => BattleState
}

function getTerrainMoveCost(cell: TerrainCell): number {
  return cell.effects?.moveCost ?? 1
}

export function moveUnitsForward(state: BattleState, deps: MovementSystemDeps): BattleState {
  let next: BattleState = {
    ...state,
    grid: state.grid.map((r) => r.map((c) => ({ ...c }))),
    units: { ...state.units },
  }

  const { battlefield } = state.config

  // 只有状态为 'on_field' 且不是刚部署的单位才能移动
  const unitsArray = Object.values(state.units).filter((u) => u.status === 'on_field' && !u.justDeployedThisTurn)

  // 按照移动优先级排序，优先级高的先移动
  const sortedUnitsArray = unitsArray.sort((a, b) => {
    const templateA = deps.findTemplateById(state.config, a.templateId)
    const templateB = deps.findTemplateById(state.config, b.templateId)
    if (!templateA || !templateB) return 0

    const priorityA = deps.calculateMovePriority(a, templateA, state.config)
    const priorityB = deps.calculateMovePriority(b, templateB, state.config)

    // 优先级高的先移动（降序）
    return priorityB - priorityA
  })

  for (const unit of sortedUnitsArray) {
    const template = deps.findTemplateById(state.config, unit.templateId)
    if (!template) continue
    if (template.behavior.movePattern !== 'standard_advance') continue

    const dir = deps.getForwardDirectionForOwner(unit.owner === 'neutral' ? 'player' : unit.owner, state.config)
    const maxCol =
      unit.owner === 'player'
        ? battlefield.playerAdvanceMaxCol
        : unit.owner === 'enemy'
          ? battlefield.enemyAdvanceMaxCol
          : dir === 1
            ? battlefield.enemyAdvanceMaxCol
            : battlefield.playerAdvanceMaxCol

    // 士气效果：兽人在士气>100时，不被阻挡的情况下额外移动一格
    const morale = unit.owner === 'player' ? state.playerMorale : state.enemyMorale
    const isEnemyUnit = unit.owner === 'enemy'
    const isOrkFaction = template.faction === 'ork'
    const isOrkEnemy = isEnemyUnit && isOrkFaction

    // 兽人低士气效果：士气<50时，有一定概率后退或不移动
    if (isOrkEnemy && morale < 50) {
      const retreatChance = (50 - morale) / 50 // 0~50%的概率
      if (Math.random() < retreatChance) {
        // 尝试后退（如果后方没有友军）
        const retreatCol = unit.col - dir
        if (retreatCol >= 1 && retreatCol <= battlefield.cols) {
          const retreatColIdx = retreatCol - 1
          const retreatRowIdx = unit.row - 1
          // 检查后方是否有友军
          const hasAllyBehind = Object.values(next.units).some(
            (u) => u.owner === unit.owner && u.row === unit.row && u.col === retreatCol && u.id !== unit.id,
          )
          if (!hasAllyBehind && !deps.isCellOccupied(next.grid, retreatRowIdx, retreatColIdx)) {
            // 后退
            deps.removeUnitFromGrid(next.grid, unit.id)
            const updatedUnit: UnitInstance = {
              ...unit,
              row: unit.row,
              col: retreatCol,
            }
            next.units[unit.id] = updatedUnit
            deps.placeUnitOnGrid(next.grid, unit.id, retreatRowIdx, retreatColIdx, template)
            // 记录后退日志
            next = deps.addPendingLogEntry(
              next,
              'unit_moved',
              `${template.name}(${unit.id}) 因低士气从 (${unit.row}, ${unit.col}) 后退到 (${unit.row}, ${retreatCol})`,
              {
                unitId: unit.id,
                templateId: template.id,
                fromRow: unit.row,
                fromCol: unit.col,
                toRow: unit.row,
                toCol: retreatCol,
                moveType: 'retreat',
                reason: 'low_morale',
                morale,
              },
            )
            continue // 后退后不再前进
          }
        }
        // 如果无法后退，则不移动（跳过前进）
        continue
      }
    }

    const currentRowIdx = unit.row - 1
    const currentTerrain = deps.getTerrainCell(state, unit.row, unit.col)

    // ========== 引流地形：覆盖本回合移动方向（仅纵向移动一格） ==========
    const funnelDir = currentTerrain.effects?.directional?.funnelDirection
    if (funnelDir) {
      const dr = funnelDir === 'up' ? -1 : 1
      const targetRow = unit.row + dr
      const targetCol = unit.col

      if (targetRow >= 1 && targetRow <= battlefield.rows) {
        const targetRowIdx = targetRow - 1
        const targetColIdx = targetCol - 1
        const targetTerrain = deps.getTerrainCell(state, targetRow, targetCol)
        const targetCell = next.grid[targetRowIdx][targetColIdx]

        // 不能进入阻挡格，不能与任意单位重叠
        let targetBlocked = false
        if (template.space === 'air') {
          targetBlocked = Boolean(targetCell.airUnitId || targetCell.fullUnitId)
        } else if (template.space === 'ground') {
          targetBlocked = Boolean(targetCell.groundUnitId || targetCell.airUnitId || targetCell.fullUnitId)
        } else {
          targetBlocked = Boolean(targetCell.groundUnitId || targetCell.airUnitId || targetCell.fullUnitId)
        }

        if (!deps.isTerrainBlocked(targetTerrain, template.space) && !targetBlocked) {
          deps.removeUnitFromGrid(next.grid, unit.id)
          const updatedUnit: UnitInstance = {
            ...unit,
            row: targetRow,
            col: targetCol,
          }
          next.units[unit.id] = updatedUnit
          deps.placeUnitOnGrid(next.grid, unit.id, targetRowIdx, targetColIdx, template)
          next = deps.addPendingLogEntry(
            next,
            'unit_moved',
            `${template.name}(${unit.id}) 因地形引流从 (${unit.row}, ${unit.col}) 移动到 (${targetRow}, ${targetCol})`,
            {
              unitId: unit.id,
              templateId: template.id,
              fromRow: unit.row,
              fromCol: unit.col,
              toRow: targetRow,
              toCol: targetCol,
              moveType: 'funnel',
            },
          )
          continue
        }
      }
      continue
    }

    // ========== 正常前进：沿着列方向向前移动 ==========
    let moveDistance = template.baseStats.moveSpeed || 1

    // 地形对移动距离的加成（站立格）
    if (currentTerrain.effects?.moveBonus && template.space === 'ground') {
      moveDistance += currentTerrain.effects.moveBonus
    }

    // 兽人高士气效果：士气>100时，不被阻挡的情况下额外移动一格
    if (isOrkEnemy && morale > 100) {
      const forwardCol = unit.col + dir
      if (forwardCol >= 1 && forwardCol <= battlefield.cols) {
        const forwardColIdx = forwardCol - 1
        if (!deps.isCellOccupied(next.grid, currentRowIdx, forwardColIdx)) {
          moveDistance += 1
        }
      }
    }

    // Demo 需求：通过标签整体限制移动力为 1
    if (template.tags?.includes('limit_move_speed_to_1') && moveDistance > 1) {
      moveDistance = 1
    }

    let moved = false
    for (let step = moveDistance; step >= 1; step -= 1) {
      const targetCol = unit.col + dir * step
      if (targetCol < 1 || targetCol > battlefield.cols) continue
      if ((dir === 1 && targetCol > maxCol) || (dir === -1 && targetCol < maxCol)) continue

      const targetColIdx = targetCol - 1
      const targetTerrain = deps.getTerrainCell(state, unit.row, targetCol)
      if (deps.isTerrainBlocked(targetTerrain, template.space)) continue
      const terrainMoveCost = getTerrainMoveCost(targetTerrain)
      if (step < terrainMoveCost) continue

      // 不能"跨越"路径上的任何单位（包括敌我双方）
      let pathBlocked = false
      for (let k = 1; k <= step; k += 1) {
        const pathCol = unit.col + dir * k
        if (pathCol < 1 || pathCol > battlefield.cols) {
          pathBlocked = true
          break
        }
        const pathColIdx = pathCol - 1
        const pathCell = next.grid[currentRowIdx][pathColIdx]

        if (template.space === 'air') {
          if (pathCell.airUnitId || pathCell.fullUnitId) {
            pathBlocked = true
            break
          }
        } else if (template.space === 'ground') {
          if (pathCell.groundUnitId || pathCell.airUnitId || pathCell.fullUnitId) {
            pathBlocked = true
            break
          }
        } else {
          if (pathCell.groundUnitId || pathCell.airUnitId || pathCell.fullUnitId) {
            pathBlocked = true
            break
          }
        }
      }
      if (pathBlocked) continue

      const targetCell = next.grid[currentRowIdx][targetColIdx]
      if (template.space === 'air') {
        if (targetCell.airUnitId || targetCell.fullUnitId) continue
      } else if (template.space === 'ground') {
        if (targetCell.groundUnitId || targetCell.airUnitId || targetCell.fullUnitId) continue
      } else {
        if (targetCell.groundUnitId || targetCell.airUnitId || targetCell.fullUnitId) continue
      }

      deps.removeUnitFromGrid(next.grid, unit.id)
      const updatedUnit: UnitInstance = {
        ...unit,
        row: unit.row,
        col: targetCol,
      }
      next.units[unit.id] = updatedUnit
      deps.placeUnitOnGrid(next.grid, unit.id, currentRowIdx, targetColIdx, template)

      const currentTerrain = deps.getTerrainCell(state, unit.row, unit.col)
      next = deps.addPendingLogEntry(
        next,
        'unit_moved',
        `${template.name}(${unit.id}) 从 (${unit.row}, ${unit.col}) 移动到 (${unit.row}, ${targetCol})，移动距离 ${step}`,
        {
          unitId: unit.id,
          templateId: template.id,
          fromRow: unit.row,
          fromCol: unit.col,
          toRow: unit.row,
          toCol: targetCol,
          moveDistance: step,
          moveType: 'standard_advance',
          moveContext: {
            baseMoveSpeed: template.baseStats.moveSpeed || 1,
            terrainMoveBonus: currentTerrain?.effects?.moveBonus ?? 0,
            terrainMoveCost: getTerrainMoveCost(targetTerrain),
            morale: unit.owner === 'player' ? state.playerMorale : state.enemyMorale,
            isOrkEnemy: unit.owner === 'enemy' && state.config.enemyFaction === 'ork',
            maxCol: maxCol,
            direction: dir,
          },
        },
      )
      moved = true
      break
    }

    if (!moved) {
      // 无法移动则保持原地
    }
  }

  return next
}
