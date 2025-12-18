// damageSystem.ts
// 说明：伤害计算相关的纯逻辑被集中在此文件中，负责“从攻击与上下文计算出数值结果”，
// 不直接修改 BattleState，也不写入日志，由上层引擎负责状态与日志更新。

import type {
  BattleState,
  UnitInstance,
  UnitTemplate,
  DamageType,
  TerrainCell,
} from './types'

// 说明：此文件目前只负责纯数值计算（不直接 mutate BattleState），
// 但为了保持与引擎中 Immer 配置一致，避免未来在这里使用 produce 时出现 autoFreeze 冻结，
// 也在全局关闭 autoFreeze（如果已经关闭，多次调用也是安全的）。
import { setAutoFreeze } from 'immer'
setAutoFreeze(false)

export interface DamageResult {
  damage: number
  isCrit: boolean
  effectiveAttack: number
  baseDamage: number
  damageMultiplier: number
  damageTakenMultiplier: number
}

export interface ApplyDamageOptions {
  damageType?: DamageType
  canCrit?: boolean
  forceCrit?: boolean
  splashFactor?: number
  skillMultiplier?: number
  ignoreMorale?: boolean
  wasSplash?: boolean
  attackerUnitId?: string | null
}

// 当前所有单位统一暴击率与暴击伤害
function getCritParams(): { critRate: number; critMultiplier: number } {
  return {
    critRate: 0.1, // 10% 暴击率
    critMultiplier: 2.0, // 200% 暴击伤害
  }
}

export function getDamageTypeForTemplate(template: UnitTemplate): DamageType {
  return template.damageType ?? 'physical'
}

/**
 * 计算攻击方"有效攻击力"
 * （基础攻击、Buff加成、士气加成、地形攻击加成、技能倍率、暴击倍率、溅射系数）
 */
/**
 * 计算士气对攻击力的影响
 * 与 `engine.ts` 中的实现保持一致，避免行为差异
 */
function calculateMoraleAttackBonus(morale: number): number {
  if (morale > 100) {
    return 1.1
  } else if (morale < 50) {
    return 0.9
  }
  return 1.0
}

export function calculateEffectiveAttackValue(
  template: UnitTemplate,
  morale: number,
  attackerTerrain: TerrainCell | null,
  options?: {
    splashFactor?: number
    unitBuffs?: Array<{ type: string; magnitude?: number }>
    skillMultiplier?: number
    critMultiplier?: number
  },
): number {
  const baseAttack = template.baseStats.attack
  const moraleBonus = calculateMoraleAttackBonus(morale)
  const terrainAttackMod = attackerTerrain?.effects?.attackModifier ?? 1
  const splashFactor = options?.splashFactor ?? 1
  const skillMultiplier = options?.skillMultiplier ?? 1.0
  const critMultiplier = options?.critMultiplier ?? 1.0

  let buffBonus = 0
  if (options?.unitBuffs) {
    for (const buff of options.unitBuffs) {
      if (buff.type === 'attack_up' && buff.magnitude) {
        buffBonus += buff.magnitude
      }
    }
  }

  const effective =
    (baseAttack + buffBonus) *
    moraleBonus *
    terrainAttackMod *
    skillMultiplier *
    critMultiplier *
    splashFactor
  return Math.max(0, effective)
}

/**
 * 按伤害类型计算基础伤害
 */
export function calculateBaseDamageByType(
  damageType: DamageType,
  effectiveAttack: number,
  targetTemplate: UnitTemplate,
): number {
  if (damageType === 'physical') {
    const physDef = targetTemplate.baseStats.physRes
    const atkMinusDef = Math.max(0, effectiveAttack - physDef)
    const atkTimes03 = effectiveAttack * 0.03
    const base = Math.max(atkMinusDef, atkTimes03)
    return Math.max(1, Math.floor(base))
  }

  if (damageType === 'magic') {
    const magicRes = Math.max(0, Math.min(100, targetTemplate.baseStats.magicRes))
    const base = effectiveAttack * (1 - magicRes / 100)
    return Math.max(1, Math.floor(base))
  }

  return Math.max(1, Math.floor(effectiveAttack))
}

/**
 * 应用受伤倍率（地形减伤/增伤）
 */
export function applyTakenMultiplier(
  damageAfterMultiplier: number,
  _damageType: DamageType,
  defenderTerrain: TerrainCell | null,
): number {
  const terrainTakenMod = defenderTerrain?.effects?.damageTakenModifier ?? 1
  const result = damageAfterMultiplier * terrainTakenMod
  return Math.max(1, Math.floor(result))
}

/**
 * 统一的对单位造成伤害的计算函数（纯数值，不改状态）
 */
export function calculateDamageAgainstUnit(
  state: BattleState,
  attackerTemplate: UnitTemplate,
  attackerOwner: 'player' | 'enemy' | 'neutral',
  attackerRow: number,
  attackerCol: number,
  target: UnitInstance,
  options?: ApplyDamageOptions,
  helpers?: {
    getTerrainCell: (state: BattleState, row: number, col: number) => TerrainCell
    findTemplateById: (config: any, templateId: string) => UnitTemplate | undefined
    getMoraleForOwner: (state: BattleState, owner: 'player' | 'enemy' | 'neutral') => number
  },
): DamageResult {
  const damageType = options?.damageType ?? getDamageTypeForTemplate(attackerTemplate)

  const morale =
    options?.ignoreMorale === true
      ? 100
      : helpers?.getMoraleForOwner
      ? helpers.getMoraleForOwner(state, attackerOwner)
      : 100

  const getTerrain = helpers?.getTerrainCell
  const attackerTerrain = getTerrain ? getTerrain(state, attackerRow, attackerCol) : null
  const defenderTerrain = getTerrain ? getTerrain(state, target.row, target.col) : null

  const targetTemplate =
    helpers?.findTemplateById?.(state.config, target.templateId) ??
    ({
      baseStats: { hp: target.maxHp, attack: 0, physRes: 0, magicRes: 0, moveSpeed: 0, range: 1 },
    } as UnitTemplate)

  const attackerUnit = options?.attackerUnitId ? state.units[options.attackerUnitId] : null
  const attackerBuffs = attackerUnit?.buffs || []

  const { critRate, critMultiplier } = getCritParams()
  let isCrit = false
  if (options?.forceCrit) {
    isCrit = true
  } else if (options?.canCrit !== false) {
    isCrit = Math.random() < critRate
  }

  const critMultiplierForAttack = isCrit ? critMultiplier : 1.0

  const effectiveAttack = calculateEffectiveAttackValue(attackerTemplate, morale, attackerTerrain, {
    splashFactor: options?.splashFactor,
    unitBuffs: attackerBuffs,
    skillMultiplier: options?.skillMultiplier,
    critMultiplier: critMultiplierForAttack,
  })

  const baseDamage = calculateBaseDamageByType(damageType, effectiveAttack, targetTemplate)
  const damageMultiplier = isCrit ? critMultiplier : 1.0
  const damageTakenMultiplier = defenderTerrain?.effects?.damageTakenModifier ?? 1
  const finalDamage = applyTakenMultiplier(baseDamage, damageType, defenderTerrain)

  return {
    damage: finalDamage,
    isCrit,
    effectiveAttack,
    baseDamage,
    damageMultiplier,
    damageTakenMultiplier,
  }
}

