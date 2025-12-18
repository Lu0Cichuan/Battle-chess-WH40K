# 未来扩展功能文档

本文档记录了战斗引擎中预留的扩展接口和未来开发计划。

## 1. 卡牌组织标识系统（Organization Identifier System）

### 1.1 设计目标
为卡牌添加详细的组织层级标识，实现更真实的命名系统，例如：
- `帝国线列步兵（卡迪安星系-第8团-第3连-第2排-第1班）`
- `战术星际战士（极限战士战团-第2连-阿尔法小队）`

### 1.2 预留接口

在 `types.ts` 中的 `CardInventory` 接口已预留扩展字段：
```typescript
interface CardInventory {
  // ... MVP字段
  
  // 未来扩展：组织标识（OrganizationIdentifier）
  // organization?: OrganizationIdentifier
}
```

### 1.3 数据结构设计

#### 组织层级枚举
```typescript
type GuardLevel = 'sector' | 'regiment' | 'company' | 'platoon' | 'squad'
type MarineLevel = 'chapter' | 'company' | 'squad'
type CustodesLevel = 'shield_host' | 'squad'
type SororitasLevel = 'order' | 'preceptory' | 'squad'
type PDFLevel = 'regiment' | 'company' | 'platoon' | 'squad'
```

#### 组织标识接口
```typescript
interface OrganizationIdentifier {
  // 兵种类型
  unitType: 'guard' | 'marine' | 'custodes' | 'sororitas' | 'pdf'
  
  // 层级路径（从大到小）
  // 例如：['卡迪安星系', '第8团', '第3连', '第2排', '第1班']
  hierarchy: string[]
  
  // 层级类型路径（对应 hierarchy）
  // 例如：['sector', 'regiment', 'company', 'platoon', 'squad']
  levelTypes: string[]
}
```

### 1.4 命名规则

#### 星界军（Astra Militarum）
```
{基础名称}（{星系名}-{团编号}-{连编号}-{排编号}-{班编号}）
示例：帝国线列步兵（卡迪安星系-第8团-第3连-第2排-第1班）
```

#### 阿斯塔特战团（Space Marine Chapter）
```
{基础名称}（{战团名}-{连编号}-{小队名}）
示例：战术星际战士（极限战士战团-第2连-阿尔法小队）
```

#### 禁军（Adeptus Custodes）
```
{基础名称}（{盾卫名}-{小队编号}）
示例：禁军卫士（太阳盾卫-第3小队）
```

#### 寂静修女（Adepta Sororitas）
```
{基础名称}（{修会名}-{教团编号}-{小队名}）
示例：战斗修女（血腥玫瑰修会-第5教团-战斗小队）
```

### 1.5 实现计划

1. **阶段1：数据结构扩展**
   - 添加 `OrganizationIdentifier` 接口
   - 扩展 `CardInventory` 和 `BattleCard` 接口
   - 创建组织生成器（`OrganizationGenerator`）

2. **阶段2：命名系统**
   - 实现不同兵种的命名模板
   - 支持本地化（中英文）
   - 自动生成显示名称

3. **阶段3：阵亡管理增强**
   - 阵亡单位从对应组织层级中移除
   - 支持组织层级的动态调整
   - 记录阵亡统计信息

### 1.6 相关文件
- `types.ts`: 类型定义
- `engine.ts`: 组织生成和命名逻辑
- `inventory.ts`: 背包系统中的组织管理（未来实现）

## 2. 士气系统（Morale System）

### 2.1 设计目标
实现全局士气系统，影响所有单位的战斗表现。

### 2.2 核心机制

#### 士气值范围
- 初始值：100（双方）
- 范围：0-200（可配置）

#### 士气变化规则
- **回合推进**：每回合 -1（长期战斗的疲劳）
- **单位阵亡**：-5（每个单位）
- **基地受损**：-10（每次受到伤害）
- **任务进展**：+10（完成特定目标）

#### 士气效果
- **高士气（>120）**：+10% 攻击力，+5% 移动速度
- **正常士气（80-120）**：无加成
- **低士气（<80）**：-10% 攻击力，-5% 移动速度
- **崩溃（<30）**：-30% 攻击力，-20% 移动速度，可能逃跑

### 2.3 预留接口

在 `types.ts` 中的 `BattleState` 接口需要添加：
```typescript
interface BattleState {
  // ... 现有字段
  
  // 未来扩展：士气系统
  // playerMorale: number
  // enemyMorale: number
}
```

### 2.4 实现计划

1. **阶段1：基础系统**
   - 添加士气值到 `BattleState`
   - 实现士气变化规则
   - 实现士气效果计算

2. **阶段2：UI显示**
   - 士气条显示
   - 士气变化提示
   - 士气效果图标

3. **阶段3：高级功能**
   - 士气恢复机制
   - 特殊单位对士气的影响
   - 士气相关的特殊事件

### 2.5 相关文件
- `types.ts`: 类型定义
- `engine.ts`: 士气计算逻辑
- `App.tsx`: UI显示

## 3. 更复杂的攻击规则

### 3.1 优先级系统
- **攻击优先级**：距离 > 血量 > 类型
- **目标选择**：最近 > 最弱 > 特定类型

### 3.2 不同射程
- **近战（1格）**：只能攻击相邻单位
- **远程（2-3格）**：可以攻击范围内的单位
- **超远程（4+格）**：可以攻击更远的单位

### 3.3 溅射伤害
- **范围攻击**：对目标周围单位造成伤害
- **溅射范围**：可配置（1x1, 3x3等）
- **伤害衰减**：距离越远，伤害越低

### 3.4 预留接口

在 `types.ts` 中的 `UnitTemplate` 接口需要扩展：
```typescript
interface UnitTemplate {
  // ... 现有字段
  
  // 未来扩展：攻击规则
  // attackPriority?: AttackPriority[]
  // splashDamage?: SplashDamageConfig
}
```

## 4. 特殊移动模式

### 4.1 斜向移动
- 单位可以斜向移动
- 移动距离计算需要考虑对角线

### 4.2 跳跃/传送
- 单位可以跳过障碍物
- 传送到指定位置

### 4.3 飞行单位
- 可以飞越地面单位
- 不受地形限制

### 4.4 预留接口

在 `types.ts` 中的 `MovePattern` 类型需要扩展：
```typescript
type MovePattern = 
  | 'standard_advance' 
  | 'no_move' 
  | 'custom'
  // 未来扩展：
  // | 'diagonal'
  // | 'jump'
  // | 'teleport'
  // | 'flying'
```

## 5. 战斗事件系统

### 5.1 随机事件
- 中立单位出现
- 环境伤害（毒气、火焰等）
- 支援单位到达

### 5.2 预留接口

在 `types.ts` 中的 `BattleEvent` 接口已定义：
```typescript
interface BattleEvent {
  id: string
  type: BattleEventType
  triggerTurn: number
  params?: Record<string, unknown>
}
```

### 5.3 实现计划
- 事件触发器系统
- 事件效果系统
- 事件UI显示

## 6. 战斗结算增强

### 6.1 经验值系统
- 单位获得经验值
- 升级系统
- 属性提升

### 6.2 掉落物品
- 战斗中获得物品
- 物品类型：武器、装备、消耗品

### 6.3 预留接口

在 `types.ts` 中的 `BattleResult` 接口需要扩展：
```typescript
interface BattleResult {
  // ... 现有字段
  
  // 未来扩展：
  // experienceGained?: number
  // itemsDropped?: Item[]
  // unitsLeveledUp?: string[]
}
```

## 7. 战斗回放系统

### 7.1 记录战斗过程
- 记录每个回合的状态
- 记录所有操作（部署、移动、攻击）

### 7.2 回放功能
- 播放战斗过程
- 快进/快退
- 暂停/继续

### 7.3 实现计划
- 状态快照系统
- 操作记录系统
- 回放播放器

## 8. 多人对战支持

### 8.1 网络同步
- 状态同步
- 操作验证
- 断线重连

### 8.2 预留接口
- 网络协议设计
- 服务器架构
- 客户端同步逻辑

## 开发优先级建议

1. **高优先级**（核心功能）
   - 士气系统
   - 更复杂的攻击规则
   - 战斗结算增强

2. **中优先级**（增强体验）
   - 卡牌组织标识系统
   - 特殊移动模式
   - 战斗事件系统

3. **低优先级**（高级功能）
   - 战斗回放系统
   - 多人对战支持

## 注意事项

- 所有扩展功能都应该保持向后兼容
- 预留接口应该使用可选字段（`?`）
- 新功能应该先实现MVP版本，再逐步完善
- 文档应该及时更新，反映最新的设计决策





