// effectSystem.ts
// 说明：Effect System 负责 Buff / 状态 / 技能（法术）等“效果结算”。
// 第一阶段：只迁移现有的勇气光环（courage-aura）实现，保持行为不变。

import type { BattleState, UnitInstance } from './types'

export interface EffectSystemDeps {
  updateMorale: (state: BattleState, owner: 'player' | 'enemy', delta: number) => BattleState
}

export function applyCourageAura(state: BattleState, centerRow: number, centerCol: number, deps: EffectSystemDeps): BattleState {
  const { rows, cols } = state.config.battlefield
  let next: BattleState = {
    ...state,
    units: { ...state.units },
  }

  // 计算3x3范围内的友军单位
  const affectedUnits: UnitInstance[] = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const targetRow = centerRow + dr
      const targetCol = centerCol + dc
      if (targetRow < 1 || targetRow > rows || targetCol < 1 || targetCol > cols) continue

      const rowIdx = targetRow - 1
      const colIdx = targetCol - 1
      const cell = state.grid[rowIdx][colIdx]

      const unitId = cell.groundUnitId || cell.airUnitId || cell.fullUnitId
      if (!unitId) continue

      const unit = state.units[unitId]
      if (!unit || unit.owner !== 'player' || unit.status === 'dead') continue
      if (unit.isDeployBeacon) continue

      affectedUnits.push(unit)
    }
  }

  // 为范围内的友军单位添加攻击力+2的Buff（持续1回合）
  const buffId = `courage-aura-${Date.now().toString(36)}`
  for (const unit of affectedUnits) {
    const updatedUnit: UnitInstance = {
      ...unit,
      buffs: [
        ...unit.buffs,
        {
          id: buffId,
          templateId: 'courage-aura',
          type: 'attack_up',
          remainingTurns: 1,
          magnitude: 2,
        },
      ],
    }
    next.units[unit.id] = updatedUnit
  }

  // 增加士气：范围内单位数 * 3
  const moraleGain = affectedUnits.length * 3
  next = deps.updateMorale(next, 'player', moraleGain)

  console.log(
    `[勇气光环] 在 (${centerRow},${centerCol}) 施放，影响 ${affectedUnits.length} 个友军单位，获得 ${moraleGain} 士气`,
  )

  return next
}


