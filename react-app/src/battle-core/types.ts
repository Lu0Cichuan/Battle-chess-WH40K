export type Faction = 'imperium' | 'ork' | 'aeldari' | 'chaos' | 'neutral'

export type Owner = 'player' | 'enemy' | 'neutral'

export interface BattlefieldConfig {
  rows: number
  cols: number
  playerDeployCols: [number, number]
  enemyDeployCols: [number, number]
  playerAdvanceMaxCol: number
  enemyAdvanceMaxCol: number
  playerBaseCol: number
  enemyBaseCol: number
  // 可选的地形配置（与战场网格同尺寸）；不提供时默认全平原
  terrain?: TerrainGrid
}

export type SpaceLayer = 'ground' | 'air' | 'full'

export interface CellLayers {
  groundUnitId: string | null
  airUnitId: string | null
  fullUnitId: string | null
}

export type BattlefieldGrid = CellLayers[][]

export type TerrainType = 'plain' | 'cover' | 'difficult' | 'road' | 'water' | 'impassable'

// 基础数值效果，可被复用/覆写
export interface TerrainNumericEffects {
  moveCost?: number // 进入该格需要的移动点（默认1）；>移动距离则无法进入
  moveBonus?: number // 站在该格时额外移动距离
  attackModifier?: number // 站在该格时对攻击的乘算系数（默认1）
  damageTakenModifier?: number // 站在该格时受到伤害的乘算系数（默认1；<1代表掩体）
  blocksGround?: boolean // 阻挡地面单位进入
  blocksAir?: boolean // 阻挡空中单位进入
  blocksFull?: boolean // 阻挡占满格的单位进入
  blocksBuilding?: boolean // 阻挡建筑类单位
  blocksTitan?: boolean // 阻挡泰坦类单位
}

export interface TerrainVisual {
  spriteId?: string // 主贴图/精灵
  overlayId?: string // 覆盖层贴图，例如毒雾/火焰
  tint?: string // 颜色遮罩
  animationId?: string // 动画效果（如流动、闪烁）
  height?: number // 高度（用于高低差判定）
}

export type FunnelDirection = 'up' | 'down'

export interface TerrainDirectionalEffects {
  attackFromHigherBonus?: number // 高打低攻击系数（>1为增伤）
  attackFromLowerPenalty?: number // 低打高减伤系数（<1为减伤）
  defendOnHigherBonus?: number // 站在高地受到攻击时的减伤系数
  // 纵向引流方向：单位站在该格上时，优先向上/向下移动一格（覆盖本回合的默认前进方向）
  funnelDirection?: FunnelDirection
}

export interface TerrainEffects extends TerrainNumericEffects {
  tags?: string[] // 自定义标签，如 'toxic'、'lava'
  visual?: TerrainVisual // 贴图/高度等视觉或高低差信息
  // 按单位类别覆写效果（含建筑、泰坦），默认继承基础效果
  perSpace?: Partial<Record<'ground' | 'air' | 'full' | 'building' | 'titan', TerrainNumericEffects>>
  directional?: TerrainDirectionalEffects // 基于高低差或方向的效果占位
}

export interface TerrainCell {
  type: TerrainType
  effects?: TerrainEffects
}

export type TerrainGrid = TerrainCell[][]

export interface Base {
  id: string
  owner: Owner
  hp: number
  maxHp: number
  attack: number
  range: number
  // 基地在一次“反击”中最多可攻击的目标数量（默认1）
  maxTargets?: number
  column: number
}

export type UnitType = 'army' | 'building' | 'spell' | 'hero' | 'deploy_beacon'

export type MovePattern = 'standard_advance' | 'no_move' | 'custom'
export type AttackPattern = 'closest_in_row' | 'nearest_by_distance' | 'support'
export type TargetFilter = 'enemy_only' | 'all' | 'ally_only'

// 索敌优先级规则（MVP：仅实现通用规则与建筑优先/只打建筑）
export type TargetPriorityRule =
  | 'prefer_units' // 默认：普通单位优先，若无单位则打建筑/障碍
  | 'prefer_buildings' // 建筑优先，其次打普通单位
  | 'buildings_only' // 仅攻击建筑（若范围内没有建筑则不攻击）

// 基于格子的攻击/索敌模板（以自身为中心）
export interface AttackPatternCell {
  dr: number // 行偏移（负数=上，正数=下）
  dc: number // 列偏移（正数=朝前方向，负数=背后）
}

export interface AttackPatternConfig {
  cells: AttackPatternCell[] // 可攻击/索敌的相对格子集合
  // 命中类型限制（预留未来空军/泰坦/建筑差异化）
  canHitGround?: boolean
  canHitAir?: boolean
  canHitTitan?: boolean
  canHitBuilding?: boolean
}

// 伤害类型占位：物理 / 法术（灵能）/ 真实伤害
export type DamageType = 'physical' | 'magic' | 'true'

// 溅射伤害配置（MVP 版本）
export interface SplashPatternCell {
  dr: number // 相对主目标格的行偏移
  dc: number // 相对主目标格的列偏移
  coefficient: number // 该格子的溅射伤害系数（与全局 0.5 攻击衰减相乘）
}

export interface SplashConfig {
  radius: number // 溅射半径（基于曼哈顿距离，1 表示十字/菱形邻格）
  coefficient: number // 相对主目标伤害系数，例如 0.5 表示 50% 伤害
  affectAllies?: boolean // 是否会波及友军（默认 false）
  affectBuildings?: boolean // 是否会波及基地/建筑（默认 true，便于以后扩展）
  // 可选：基于格子的溅射模板；若提供则优先使用 cells 覆盖 radius 逻辑
  cells?: SplashPatternCell[]
  // 可选：溅射目标类型限制（继承自攻击配置，但可单独配置）
  // 如果未配置，则继承攻击配置的 canHitGround/canHitAir 等设置
  canHitGround?: boolean
  canHitAir?: boolean
  canHitTitan?: boolean
  canHitBuilding?: boolean
}

export interface UnitTemplate {
  id: string
  name: string
  faction: Faction
  type: UnitType
  space: SpaceLayer
  cost: number
  baseStats: {
    hp: number
    attack: number
    physRes: number
    magicRes: number
    moveSpeed: number
    range: number
  }
  tags: string[]
  behavior: {
    movePattern: MovePattern
    attackPattern: AttackPattern
    targetFilter: TargetFilter
    // 可选：单位独有的索敌优先级策略
    targetPriority?: TargetPriorityRule[]
  }
  // 可选：基于格子的攻击/索敌范围配置；若未配置，则使用旧的“同一行 + 前方 + range”逻辑
  attackPatternConfig?: AttackPatternConfig
  // 当前单位主要造成的伤害类型（默认视为物理伤害）
  damageType?: DamageType
  // 可选的溅射配置；未配置则为单体攻击
  splashConfig?: SplashConfig
  deployDelayTurns: number
  undeployDelayTurns: number // 反部署延迟回合数
  deployMoraleValue: number // 部署时提供的士气值（部署完成时生效）
  // 技能列表（按优先级排序，从上到下检查可用技能）
  skills?: SkillConfig[]
}

export type BuffType = 'poison' | 'stealth' | 'attack_up' | 'def_up' | 'stun' | 'custom'

export interface BuffInstance {
  id: string
  templateId: string | null
  type: BuffType
  remainingTurns: number
  magnitude?: number
  stacks?: number
  sourceUnitId?: string
  tags?: string[]
}

// ===== 技能系统 =====

// 技能目标选择类型
export type SkillTargetType = 
  | 'single'           // 单体目标（基于索敌逻辑选择）
  | 'multi'            // 多个单体目标（指定数量，基于索敌逻辑选择）
  | 'area'             // 范围内全部单位（基于攻击范围模板）

// 技能伤害行为配置
export interface SkillDamageConfig {
  enabled: boolean                    // 是否造成伤害
  damageType: DamageType              // 伤害类型：physical/magic/true
  damageMultiplier: number            // 伤害倍率（相对于基础攻击力，默认1.0）
  canCrit: boolean                    // 是否允许暴击（默认true）
  splashConfig?: SplashConfig         // 溅射配置（可选，与现有splashConfig结构一致）
  // 溅射基础倍率：用于计算溅射伤害的攻击力衰减系数
  // 例如：0.5 表示溅射伤害使用 50% 的攻击力进行计算
  // 如果未指定，则使用全局默认值 0.5
  // 注意：最终溅射伤害 = 基础攻击力 * splashBaseMultiplier * splashConfig.coefficient
  // 对于基于格子的溅射：最终溅射伤害 = 基础攻击力 * splashBaseMultiplier * cell.coefficient
  splashBaseMultiplier?: number       // 溅射基础倍率（默认0.5，范围0-1）
  ignoreMorale?: boolean              // 是否忽略士气影响（默认false）
}

// 技能Buff/Debuff行为配置
export interface SkillBuffConfig {
  enabled: boolean                    // 是否施加Buff/Debuff
  targetFilter: TargetFilter          // 目标过滤：enemy_only/ally_only/all
  buffs: Array<{                      // 要施加的Buff列表
    type: BuffType                    // Buff类型：attack_up/def_up/poison/stun等
    magnitude?: number                // Buff数值（如攻击力+2）
    duration: number                  // 持续回合数
    stacks?: number                   // 可叠加层数（默认1）
  }>
}

// 技能配置
export interface SkillConfig {
  id: string                          // 技能唯一ID
  name: string                        // 技能名称
  description?: string                // 技能描述
  targetType: SkillTargetType         // 目标选择类型
  targetCount?: number                // 目标数量（仅用于multi类型，默认1）
  targetFilter: TargetFilter          // 目标过滤：enemy_only/ally_only/all
  targetPriority?: TargetPriorityRule[] // 目标优先级规则（与现有targetPriority一致）
  attackPatternConfig?: AttackPatternConfig // 攻击范围配置（与现有attackPatternConfig一致）
  damageConfig?: SkillDamageConfig    // 伤害行为配置
  buffConfig?: SkillBuffConfig        // Buff/Debuff行为配置
  cooldownTurns: number               // 冷却回合数（0表示无冷却）
  blocksMovement: boolean             // 是否阻塞后续移动（默认true）
  blocksOtherSkills: boolean          // 是否阻塞后续技能释放（默认false，但释放技能后通常不能再释放其他技能）
}

// 单位实例中的技能状态
export interface SkillCooldownState {
  skillId: string                     // 技能ID
  remainingCooldown: number           // 剩余冷却回合数
  lastUsedTurn?: number               // 上次使用回合（可选，用于调试）
}

// 伤害历史记录条目（完整版，包含所有计算值）
export interface DamageLogEntry {
  turnNumber: number
  sourceUnitId: string | null // 伤害来源单位ID（null表示环境伤害）
  sourceTemplateId: string | null // 伤害来源模板ID
  damageType: DamageType
  baseDamage: number // 基础伤害（计算值，快照中不保存）
  effectiveAttack: number // 有效攻击力（计算值，快照中不保存）
  isCrit: boolean // 是否暴击（计算值，快照中不保存）
  damageMultiplier: number // 伤害倍率（计算值，快照中不保存）
  damageTakenMultiplier: number // 受伤倍率（计算值，快照中不保存）
  finalDamage: number // 最终伤害（结果数据，快照中保存）
  wasSplash: boolean // 是否为溅射伤害
  targetHpBefore: number // 受击前HP（状态数据，快照中保存）
  targetHpAfter: number // 受击后HP（状态数据，快照中保存）
}

// 快照中使用的简化版伤害历史（只保存原始数据，不保存计算值）
export interface SimplifiedDamageLogEntry {
  turnNumber: number
  sourceUnitId: string | null
  sourceTemplateId: string | null
  damageType: DamageType
  finalDamage: number // 最终伤害（结果数据）
  wasSplash: boolean
  targetHpBefore: number // 受击前HP（状态数据）
  targetHpAfter: number // 受击后HP（状态数据）
  // 不包含：baseDamage, effectiveAttack, isCrit, damageMultiplier, damageTakenMultiplier
  // 这些值会在恢复后通过实时计算得到
}

export type UnitStatus = 'in_deploy_queue' | 'on_field' | 'undeploying' | 'dead' | 'just_deployed'

export interface UnitInstance {
  id: string
  templateId: string
  owner: Owner
  row: number
  col: number
  currentHp: number
  maxHp: number // 当前最大生命值（可能因损耗而降低）
  status: UnitStatus
  remainingDeployTurns: number
  remainingUndeployTurns: number // 剩余反部署回合数
  cardId: string | null // 关联的卡牌ID，用于反部署时回到牌堆
  buffs: BuffInstance[]
  // 部署信标相关属性
  isDeployBeacon?: boolean // 是否为部署信标
  deployTargetCardId?: string // 部署信标要部署的卡牌ID
  deployTargetTemplateId?: string // 部署信标要部署的单位模板ID
  deployTargetSpace?: SpaceLayer // 部署信标继承的格子占据类型
  justDeployedThisTurn?: boolean // 本回合刚部署的单位，本回合不行动
  deployMoraleValue?: number // 记录部署时提供的士气值（用于计算击杀/反部署时的士气变化）
  // 索敌锁定的目标单位ID（若目标仍在攻击范围内，则优先继续攻击该目标）
  lockedTargetId?: string | null
  // 最近一次进行主动行动的回合（用于冷却/行为控制，例如帝国火炮攻击冷却）
  lastActedTurn?: number
  // 伤害历史记录（用于调试和显示）
  damageHistory?: DamageLogEntry[]
  // 技能冷却状态列表
  skillCooldowns?: SkillCooldownState[]
}

export type CardType = 'unit' | 'spell'

// 背包中的原始卡牌数据（战役外）
export interface CardInventory {
  id: string
  type: CardType
  unitTemplateId?: string
  maxHp: number // 原始最大生命值
  currentHp: number // 当前生命值
  
  // MVP版本：简单的显示名称（例如："帝国线列步兵 #1"）
  displayName?: string
  
  // MVP版本：卡牌状态
  status?: 'available' | 'killed' // 'available': 可用, 'killed': 已阵亡
  
  // 未来可以扩展其他属性：攻击力、防御力等
  // 未来扩展：组织标识（OrganizationIdentifier）
  // organization?: OrganizationIdentifier
}

// 战斗中的卡牌副本（战斗中）
export interface BattleCard {
  id: string // 战斗中的唯一ID（可以是副本ID）
  sourceCardId: string // 指向背包中的原始卡牌ID
  type: CardType
  unitTemplateId?: string
  maxHp: number // 战斗中可能因损耗而降低
  currentHp: number // 当前生命值
  
  // MVP版本：显示名称（从源卡牌复制）
  displayName?: string
  
  // 战斗中的临时修改都记录在这里
}

// 兼容旧代码的 Card 类型（逐步废弃）
export interface Card {
  id: string
  type: CardType
  unitTemplateId?: string
  // 卡牌损耗信息（反部署后更新）
  maxHp?: number // 当前最大生命值（可能因损耗而降低）
  currentHp?: number // 当前生命值（反部署时补满）
}

export interface DeckConfig {
  cards: string[]
}

export interface ResourceRule {
  initialCommandPoints: number
  commandPointsPerTurn: number
  maxCommandPoints: number
  initialHandSize: number
  drawPerTurn: number
  handLimit: number
}

export interface PlayerBattleState {
  deck: string[]
  discardPile: string[]
  hand: string[]
  commandPoints: number
}

export type VictoryConditionType =
  | 'destroy_enemy_base'
  | 'protect_unit'
  | 'survive_turns'
  | 'destroy_specific_building'
  | 'custom'

export type DefeatConditionType =
  | 'player_base_destroyed'
  | 'key_unit_dead'
  | 'enemy_reach_player_backline'
  | 'custom'

export interface VictoryCondition {
  type: VictoryConditionType
  params?: Record<string, unknown>
}

export interface DefeatCondition {
  type: DefeatConditionType
  params?: Record<string, unknown>
}

export type BattleEventType = 'spawn_neutral_unit' | 'damage_row' | 'custom'

export interface BattleEvent {
  id: string
  type: BattleEventType
  triggerTurn: number
  params?: Record<string, unknown>
}

export type BattlePhase = 'PlayerPlanning' | 'TurnResolution' | 'Finished'

export interface BattleConfig {
  id: string
  name: string
  battlefield: BattlefieldConfig
  resourceRule: ResourceRule
  playerDeck: DeckConfig
  enemyDeck?: DeckConfig
  playerBase: Base
  enemyBase: Base
  victoryConditions: VictoryCondition[]
  defeatConditions: DefeatCondition[]
  unitTemplates: UnitTemplate[]
  battleCards: BattleCard[] // 战斗中的卡牌副本（从背包创建）
  initialPlayerMorale?: number // 初始玩家士气值（默认100）
  initialEnemyMorale?: number // 初始敌人士气值（默认100）
  enemyFaction?: Faction // 敌人种族（用于特殊士气效果）
}

export interface BattleState {
  config: BattleConfig
  grid: BattlefieldGrid
  terrain: TerrainGrid
  playerBase: Base
  enemyBase: Base
  units: Record<string, UnitInstance>
  player: PlayerBattleState
  enemy: PlayerBattleState
  playerMorale: number // 玩家士气值（0~120）
  enemyMorale: number // 敌人士气值（0~120）
  turnNumber: number
  phase: BattlePhase
  winner: 'player' | 'enemy' | null
  pendingEvents: BattleEvent[]
  // 待处理的日志条目（由游戏逻辑生成，由UI层处理并添加到BattleLog）
  pendingLogEntries?: BattleLogEntry[]
}

// ==================== 快照与日志系统 ====================

/**
 * 战斗快照：用于保存和恢复战场状态
 */
export interface BattleSnapshot {
  version: string // 快照版本号（用于兼容性检查）
  timestamp: number // 创建时间戳（毫秒）
  turnNumber: number // 回合号
  phase: BattlePhase // 当前阶段
  battleState: BattleState // 完整的战斗状态
  description?: string // 可选的描述信息
}

/**
 * 日志条目类型
 */
export type LogEntryType =
  | 'unit_deployed' // 单位部署
  | 'unit_undeployed' // 单位反部署
  | 'unit_moved' // 单位移动
  | 'unit_attacked' // 单位攻击
  | 'unit_damaged' // 单位受到伤害
  | 'unit_killed' // 单位死亡
  | 'base_damaged' // 基地受到伤害
  | 'base_destroyed' // 基地被摧毁
  | 'morale_changed' // 士气变化
  | 'card_drawn' // 抽卡
  | 'card_played' // 出牌
  | 'skill_used' // 使用技能
  | 'buff_applied' // 应用Buff
  | 'buff_expired' // Buff过期
  | 'turn_started' // 回合开始
  | 'turn_ended' // 回合结束
  | 'phase_changed' // 阶段变化
  | 'error' // 错误
  | 'debug' // 调试信息

/**
 * 战斗日志条目
 */
export interface BattleLogEntry {
  id: string // 唯一ID
  timestamp: number // 时间戳（毫秒）
  turnNumber: number // 回合号
  phase: BattlePhase // 阶段
  type: LogEntryType // 日志类型
  message: string // 日志消息
  data?: Record<string, any> // 附加数据（单位ID、伤害值等）
}

/**
 * 战斗日志：记录所有关键事件
 */
export interface BattleLog {
  entries: BattleLogEntry[]
  maxEntries?: number // 最大条目数（默认1000，超出后删除最旧的）
}

// 战斗结算结果：用于合并回背包
export interface BattleResult {
  battleId: string
  winner: 'player' | 'enemy' | null
  updatedCards: CardInventory[] // 更新后的卡牌数据（需要合并回背包）
  killedCardIds: string[] // MVP版本：阵亡卡牌ID列表（用于从可用卡牌池中移除）
  // 未来可以扩展：获得的经验、掉落物品等
}


