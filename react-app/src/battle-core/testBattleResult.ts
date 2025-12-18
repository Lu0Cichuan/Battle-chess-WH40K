import type { BattleState, BattleResult } from './types'
import { calculateBattleResult } from './engine'
import { testInventory } from './testInventory'

/**
 * 测试战斗结算逻辑
 * 这个函数模拟战斗结束后的结算过程
 */
export function testBattleResultCalculation(battleState: BattleState): void {
  console.log('=== 战斗结算测试 ===')
  console.log('战斗ID:', battleState.config.id)
  console.log('胜利方:', battleState.winner || '未分胜负')
  console.log('')

  // 计算战斗结果
  const result: BattleResult = calculateBattleResult(battleState, testInventory)

  console.log('战斗前的背包数据:')
  testInventory.forEach((card) => {
    console.log(`  ${card.id}: maxHp=${card.maxHp}, currentHp=${card.currentHp}`)
  })
  console.log('')

  console.log('战斗后的更新数据:')
  if (result.updatedCards.length === 0) {
    console.log('  没有卡牌发生变化')
  } else {
    result.updatedCards.forEach((card) => {
      const original = testInventory.find((c) => c.id === card.id)
      if (original) {
        const maxHpChange = card.maxHp - original.maxHp
        const currentHpChange = card.currentHp - original.currentHp
        console.log(`  ${card.id}:`)
        console.log(`    maxHp: ${original.maxHp} → ${card.maxHp} (${maxHpChange >= 0 ? '+' : ''}${maxHpChange})`)
        console.log(`    currentHp: ${original.currentHp} → ${card.currentHp} (${currentHpChange >= 0 ? '+' : ''}${currentHpChange})`)
      }
    })
  }
  console.log('')

  console.log('战斗副本数据:')
  battleState.config.battleCards.forEach((battleCard) => {
    const original = testInventory.find((c) => c.id === battleCard.sourceCardId)
    if (original) {
      console.log(`  ${battleCard.id} (来源: ${battleCard.sourceCardId}):`)
      console.log(`    maxHp: ${original.maxHp} → ${battleCard.maxHp}`)
      console.log(`    currentHp: ${original.currentHp} → ${battleCard.currentHp}`)
    }
  })
  console.log('==================')
}

/**
 * 获取战斗结算结果（供外部调用）
 */
export function getBattleResult(battleState: BattleState): BattleResult {
  return calculateBattleResult(battleState, testInventory)
}





