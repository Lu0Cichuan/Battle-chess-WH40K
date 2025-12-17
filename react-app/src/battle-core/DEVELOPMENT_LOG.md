# DEVELOPMENT_LOG

记录近期的开发过程、关键决策与状态。保持简洁、按时间倒序追加。

## 2025-12-17 (快照/日志体系落地 + 引擎稳定性修复)

### 目标
- 建立**可复现**的调试闭环：快照（Snapshot）+ 日志（Log）+ 调试控制台 UI。
- 修复 demo 过程中暴露的关键引擎问题（HP 下溢、移动阻挡、变量/状态更新错误等）。

### 已完成（本阶段落地内容）
- **快照系统（Snapshot）**：支持导出/恢复战斗状态。
  - 快照中保留战斗状态的“原始数据”，并对 `damageHistory` 做去计算字段的清理；恢复后由运行时重新派生/结算。
- **日志系统（Log）**：引入 `pendingLogEntries` 机制，允许引擎在单回合计算中累积日志，由 UI 统一提交到 `BattleLog`。
  - 覆盖关键事件：部署/移动/攻击/伤害/击杀/反部署完成/调试删除等。
  - 伤害日志记录完整管线关键参数，详见 `LOG_SYSTEM.md`。
- **回合增量日志导出**：新增 `logSaver.ts`，支持每回合增量日志下载（浏览器环境限制下以下载方式保存）。
- **调试控制台 UI 集成**：加入“快照/日志”页签，支持导出与查看，用于复盘和定位问题。

### 关键引擎修复与规则澄清
- **HP 边界**：伤害结算后 `currentHp` 被 clamp 到 \([0, maxHp]\)，死亡状态由结算统一处理。
- **对空/对地过滤**：索敌/攻击目标过滤接入 `canHitAir/canHitGround`。
- **空地分层阻挡**：移动阻挡逻辑区分 `space`：空军不应被地面单位阻挡（仅被空军/全域占格阻挡）。
- **道路加成限制**：道路 `moveBonus` 只对地面单位生效。
- **反部署可撤销**：点击一次进入反部署，再次点击取消反部署（避免误操作）。
- **基地攻击范围**：基地反击采用“列距离”判定（可攻击所有行的单位）；并支持**一次最多攻击多个目标**：新增 `Base.maxTargets`（本阶段配置为 2）。
- **稳定性修复**：修复多处运行时报错（重复声明、const 重新赋值、state setter 误用等）。

### 仍未完成/待推进
- **技能系统**：目前仍是设计阶段（本文件 2025-12-16），尚未把“普通攻击”统一到技能系统执行框架。
- **更强的回放**：目前“快照+日志”已具备诊断能力，但仍缺少“操作输入（玩家指令）”的结构化记录与回放播放器。

## 2025-12-16 (技能系统设计)

### 技能系统架构设计

**背景：**
当前系统使用固定的"普通攻击"行为，无法支持Boss单位的多技能系统。需要将攻击行为抽象为可配置的技能系统。

**技能数据结构设计：**

```typescript
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

// 在UnitTemplate中添加
export interface UnitTemplate {
  // ... 现有字段
  skills?: SkillConfig[]               // 技能列表（按优先级排序，从上到下检查）
}

// 在UnitInstance中添加
export interface UnitInstance {
  // ... 现有字段
  skillCooldowns?: SkillCooldownState[] // 技能冷却状态列表
}
```

**设计要点：**

1. **目标选择机制：**
   - `single`: 使用现有的索敌逻辑选择单个目标（支持锁定目标、优先级规则）
   - `multi`: 选择多个目标（按优先级和距离排序，取前N个）
   - `area`: 攻击范围内所有符合条件的单位

2. **伤害行为：**
   - 复用现有的伤害计算管线（`calculateDamageAgainstUnit`）
   - 支持伤害倍率（如1.5倍攻击力）
   - 支持溅射（复用现有`splashConfig`，可配置完整的溅射参数）：
     - `radius` 和 `coefficient`：基于曼哈顿距离的溅射
     - `cells`：基于格子的精确溅射模板（每个格子可配置独立系数）
     - `affectAllies` 和 `affectBuildings`：控制是否波及友军和建筑
   - 支持自定义溅射基础倍率（`splashBaseMultiplier`）：
     - 默认值为 0.5（全局默认）
     - 技能可配置不同的值（如 0.3 表示更弱的溅射，1.0 表示溅射伤害等于主目标伤害）
     - 最终溅射伤害计算：`基础攻击力 * splashBaseMultiplier * splashConfig.coefficient`（或 `* cell.coefficient`）
   - 支持不同伤害类型（物理/法术/真实）

3. **Buff/Debuff行为：**
   - 支持对目标施加多个Buff
   - 支持友方/敌方/全部目标
   - Buff持续时间和数值可配置

4. **冷却机制：**
   - 技能释放后进入冷却
   - 每回合开始时减少冷却时间
   - 冷却中的技能不可使用

5. **行动阻塞：**
   - `blocksMovement`: 释放技能后是否还能移动（如某些技能允许移动后释放）
   - `blocksOtherSkills`: 释放技能后是否还能释放其他技能（通常为true，但某些特殊技能可能允许连续释放）

6. **普通攻击作为默认技能：**
   - 每个单位模板自动生成一个"普通攻击"技能
   - 该技能使用现有的`attackPatternConfig`、`splashConfig`、`damageType`等配置
   - 冷却时间为0，阻塞移动

**实现计划：**

1. 在`types.ts`中添加技能相关类型定义
2. 在`UnitTemplate`和`UnitInstance`中添加技能字段
3. 创建`createDefaultAttackSkill`函数，将现有攻击配置转换为技能
4. 修改`performAttacks`为`performSkills`，按技能列表顺序检查可用技能
5. 实现技能释放逻辑（目标选择、伤害计算、Buff施加、冷却管理）
6. 在调试控制台显示技能列表和冷却状态

**兼容性考虑：**
- 对于没有定义`skills`的模板，自动生成默认的"普通攻击"技能
- 保持现有攻击逻辑的完整功能（索敌、锁定、溅射等）
- 向后兼容：现有模板无需修改即可工作

- 地形系统 MVP：新增 Terrain 类型/效果/可选视觉占位，默认平原；移动支持 moveCost/moveBonus、阻挡；攻击/基地伤害套用攻/受伤乘算；示例道路/掩体/困难地形；道路加成下改为"逐级回退"寻找可达格，避免卡死。
- 士气扩展：基地受击按伤害*0.5（至少1）快速扣士气；与部署/击杀/反部署共用同一 updateMorale。
- 攻击基地判定：不再限制中线行，只要同一行且射程内即可对基地造成伤害。
- 部署/信标：延迟后转本体，本回合不动不攻；信标占格避免重叠。
- 兼容扩展：TerrainEffects 增加 visual/tags/perSpace/directional/blocksBuilding/blocksTitan，为后续毒雾、高低差、泰坦/建筑差异保留接口。
- 伤害管线重构：引入 DamageType（物理/魔法/真实占位），统一"基础伤害 → 伤害倍率(暴击) → 受伤倍率(地形/未来易伤)"流程；物理采用 max(攻-物防, 攻*3%)（修正：使用max确保高攻击时造成正常伤害，低攻击时至少造成保底伤害），魔法采用 攻*(1-魔抗)，溅射等效于攻击减半后计算，溅射部分不暴击，信标始终视为暴击。
- 索敌与攻击框架：在 UnitTemplate 中增加 attackPatternConfig（基于格子的攻击/索敌模板），在 UnitInstance 中增加 lockedTargetId；performAttacks 使用新辅助函数按攻击模板找目标，并实现"优先继续攻击锁定目标，其次按'单位优先于建筑 + 距离最近'选择新目标"的索敌规则。
- 溅射与火炮：为帝国火炮配置 5x5 攻击/索敌范围（上下各两行+自身一行，向前5列）；保留现有十字型溅射（曼哈顿半径1），并在溅射计算中接入统一伤害管线与对信标的强制暴击规则。
- 引流地形：在 TerrainDirectionalEffects 中增加 funnelDirection（up/down），在 moveUnitsForward 中实现"单位站在引流地块上时，本回合优先纵向移动一格；若目标不可达则退回默认前进逻辑"；在示例地图的部分道路格上配置向上/向下引流，使双侧兵线逐步向中路汇聚。
- 模板 vs 卡牌机制澄清：在 `types.ts` 中明确区分 `UnitTemplate` 与 `CardInventory/BattleCard`：
  - 模板（UnitTemplate）：描述"一类军队"的基础数值和行为规则（如帝国线列步兵模板），包括初始 HP、攻击、防御、移动、攻击范围、部署/反部署延迟、部署提供的士气值等，所有同模板单位在未受损前共享同一基础配置。
  - 卡牌（CardInventory/BattleCard）：背包与战斗中的"具体部队实例"。卡牌以模板为蓝本生成，拥有自己唯一的 ID、当前/最大生命值、状态（available/killed）和可选的显示名称（如"帝国线列步兵 #2"），未来会承载个体编号、轻微数值浮动与战役履历。
  - 战斗流程中：从背包 `CardInventory` 生成战斗副本 `BattleCard`（createBattleCardsFromInventory），再由战斗牌组（DeckConfig）驱动实际部署。部署出的单位 `UnitInstance` 记录其 `templateId` 与 `cardId`，在结算与反部署时通过 `cardId` 回写损耗，模板本身仅作为"参考蓝本"不直接修改。
  - 设计意图：向战锤战役靠拢——某张卡牌一旦在战场上阵亡（status = killed），即便后续再次从同一模板招募，也只会生成"新的卡牌实例"，而不会复活这张已死亡的卡牌。当前阶段暂不实现真正的"永久移除与数值浮动"，但代码已在类型层面与战斗流转上严格区分了模板与卡牌，为未来的"部队战史/唯一性"系统预留空间。

## 2025-12-15
- 士气系统核心：全局0~120；>100攻+10%，<50攻-10%，50~100线性暴击修正；近战/远程固定暴击率与倍数；部署/击杀/反部署/基地受击影响士气；UI 士气条。
- 反部署/卡牌损耗：未阵亡单位回牌堆，maxHp 按损耗更新，currentHp 回满；阵亡单位永久移除。
- 部署延迟修正：信标占格，延迟结算后转为实体并标记 justDeployed，本回合不攻击不移动；回合末清除标记。
- 移动优先级 & 方向：按列优先避免阻塞；兽人高士气额外步，低士气可能后退。
- 抽补牌/命令点：修复补牌两张、深拷贝 deck 问题；回合开始补牌、命令点恢复。
