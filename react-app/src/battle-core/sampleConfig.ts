import type {
  BattleConfig,
  BattlefieldConfig,
  Base,
  ResourceRule,
  UnitTemplate,
  DeckConfig,
  BattleCard,
  TerrainGrid,
} from './types'
import { createBattleCardsFromInventory } from './engine'
import { testInventory } from './testInventory'

const battlefield: BattlefieldConfig = {
  rows: 7,
  cols: 12,
  // 我方在左侧，从左向右推进；敌方在右侧，从右向左推进
  playerDeployCols: [1, 5],
  enemyDeployCols: [8, 12],
  playerAdvanceMaxCol: 11,
  enemyAdvanceMaxCol: 2,
  playerBaseCol: 1,
  enemyBaseCol: 12,
}

// 简易地形示例：中路有掩体，中央有困难地形，边路为道路
const terrain: TerrainGrid = Array.from({ length: battlefield.rows }, () =>
  Array.from({ length: battlefield.cols }, () => ({
    type: 'plain',
    effects: { moveCost: 1, attackModifier: 1, damageTakenModifier: 1 },
  })),
)
// 掩体：降低受伤害，移动成本正常
terrain[2][5] = { type: 'cover', effects: { moveCost: 1, damageTakenModifier: 0.7, attackModifier: 1 } }
terrain[4][5] = { type: 'cover', effects: { moveCost: 1, damageTakenModifier: 0.7, attackModifier: 1 } }
// 困难地形：需要2点移动才能进入
terrain[3][5] = { type: 'difficult', effects: { moveCost: 2, attackModifier: 1, damageTakenModifier: 1 } }
// 道路：站在道路上额外+1移动（用于展示）
for (let c = 2; c <= 10; c++) {
  terrain[1][c - 1] = {
    type: 'road',
    effects: { moveCost: 1, moveBonus: 1, attackModifier: 1, damageTakenModifier: 1 },
  }
  terrain[5][c - 1] = {
    type: 'road',
    effects: { moveCost: 1, moveBonus: 1, attackModifier: 1, damageTakenModifier: 1 },
  }
}

// 在部分道路上添加纵向引流效果：
// 第2行（数组下标 1）的中路道路：引流方向为向下（汇聚到中线）
// 第6行（数组下标 5）的中路道路：引流方向为向上
for (let c = 4; c <= 7; c++) {
  const upper = terrain[1][c]
  terrain[1][c] = {
    type: upper.type,
    effects: {
      ...(upper.effects || {}),
      directional: {
        ...(upper.effects?.directional || {}),
        funnelDirection: 'down',
      },
    },
  }

  const lower = terrain[5][c]
  terrain[5][c] = {
    type: lower.type,
    effects: {
      ...(lower.effects || {}),
      directional: {
        ...(lower.effects?.directional || {}),
        funnelDirection: 'up',
      },
    },
  }
}
// 让战场配置持有地形
battlefield.terrain = terrain

const resourceRule: ResourceRule = {
  initialCommandPoints: 3,
  commandPointsPerTurn: 2,
  maxCommandPoints: 10,
  initialHandSize: 3,
  drawPerTurn: 1,
  handLimit: 5,
}

const playerBase: Base = {
  id: 'player-base',
  owner: 'player',
  hp: 100,
  maxHp: 100,
  attack: 10,
  range: 3,
  maxTargets: 2,
  column: battlefield.playerBaseCol,
}

const enemyBase: Base = {
  id: 'enemy-base',
  owner: 'enemy',
  hp: 60,
  maxHp: 60,
  attack: 8,
  range: 3,
  maxTargets: 2,
  column: battlefield.enemyBaseCol,
}

const basicInfantry: UnitTemplate = {
  id: 'imperium-infantry',
  name: '帝国线列步兵',
  faction: 'imperium',
  type: 'army',
  space: 'ground',
  cost: 2,
  baseStats: {
    hp: 20,
    attack: 6,
    physRes: 2,
    magicRes: 0,
    moveSpeed: 1,
    range: 1,
  },
  tags: ['infantry', 'melee'],
  behavior: {
    movePattern: 'standard_advance',
    attackPattern: 'closest_in_row',
    targetFilter: 'enemy_only',
  },
  deployDelayTurns: 1, // 部署延迟1回合
  undeployDelayTurns: 1, // 反部署延迟1回合
  deployMoraleValue: 1, // 部署时提供的士气值（线列步兵 = 1）
}

// 远程溅射单位：帝国火炮，用于演示范围伤害
const artillery: UnitTemplate = {
  id: 'imperium-artillery',
  name: '帝国火炮',
  faction: 'imperium',
  type: 'army',
  space: 'ground',
  cost: 3,
  baseStats: {
    hp: 16,
    attack: 15,
    physRes: 5,
    magicRes: 0,
    moveSpeed: 0, // 不移动，站桩输出
    range: 4, // 较长射程，便于演示
  },
  tags: ['artillery', 'ranged', 'requires_setup', 'requires_cooldown_after_attack'],
  behavior: {
    movePattern: 'no_move',
    attackPattern: 'closest_in_row',
    targetFilter: 'enemy_only',
  },
  // 攻击/索敌范围：以自身为中心，上下各两行 + 自身一行，向前 5 列，共 5x5 区域
  // 模板坐标中 dc>0 表示“朝前”，通过 dir 自动适配敌我方向
  attackPatternConfig: {
    cells: [
      // dr = -2
      { dr: -2, dc: 1 },
      { dr: -2, dc: 2 },
      { dr: -2, dc: 3 },
      { dr: -2, dc: 4 },
      { dr: -2, dc: 5 },
      // dr = -1
      { dr: -1, dc: 1 },
      { dr: -1, dc: 2 },
      { dr: -1, dc: 3 },
      { dr: -1, dc: 4 },
      { dr: -1, dc: 5 },
      // dr = 0（自身行）
      { dr: 0, dc: 1 },
      { dr: 0, dc: 2 },
      { dr: 0, dc: 3 },
      { dr: 0, dc: 4 },
      { dr: 0, dc: 5 },
      // dr = +1
      { dr: 1, dc: 1 },
      { dr: 1, dc: 2 },
      { dr: 1, dc: 3 },
      { dr: 1, dc: 4 },
      { dr: 1, dc: 5 },
      // dr = +2
      { dr: 2, dc: 1 },
      { dr: 2, dc: 2 },
      { dr: 2, dc: 3 },
      { dr: 2, dc: 4 },
      { dr: 2, dc: 5 },
    ],
    canHitGround: true,
    canHitAir: false,
    canHitBuilding: true,
  },
  // 溅射：以主目标为中心，曼哈顿半径1（十字/菱形），50% 溅射伤害
  // 继承攻击配置：只能打地面单位，不能打空中单位
  splashConfig: {
    radius: 1,
    coefficient: 0.5,
    affectAllies: false,
    affectBuildings: true,
    canHitGround: true,
    canHitAir: false, // 明确指定：溅射也不能打空中单位
  },
  deployDelayTurns: 1,
  undeployDelayTurns: 1,
  deployMoraleValue: 2, // 部署火炮提供更多士气
}

const orkBoy: UnitTemplate = {
  id: 'ork-boy',
  name: '兽人渣渣',
  faction: 'ork',
  type: 'army',
  space: 'ground',
  cost: 2,
  baseStats: {
    hp: 18,
    attack: 3,
    physRes: 0,
    magicRes: 0,
    moveSpeed: 1,
    range: 1,
  },
  tags: ['infantry', 'melee', 'limit_move_speed_to_1'],
  behavior: {
    movePattern: 'standard_advance',
    attackPattern: 'closest_in_row',
    targetFilter: 'enemy_only',
  },
  deployDelayTurns: 1, // 部署延迟1回合
  undeployDelayTurns: 1, // 反部署延迟1回合
  deployMoraleValue: 1, // 部署时提供的士气值（兽人渣渣 = 1）
}

// 兽人纸飞机：敌方空中单位
const orkPaperPlane: UnitTemplate = {
  id: 'ork-paper-plane',
  name: '兽人纸飞机',
  faction: 'ork',
  type: 'army',
  space: 'air',
  cost: 2,
  baseStats: {
    hp: 8,
    attack: 2,
    physRes: 0,
    magicRes: 0,
    moveSpeed: 1,
    range: 1,
  },
  tags: ['air', 'melee'],
  behavior: {
    movePattern: 'standard_advance',
    attackPattern: 'closest_in_row',
    targetFilter: 'enemy_only',
  },
  // 攻击范围：前方1格，对空对地都可以
  attackPatternConfig: {
    cells: [{ dr: 0, dc: 1 }],
    canHitGround: true,
    canHitAir: true,
    canHitBuilding: true,
  },
  deployDelayTurns: 1,
  undeployDelayTurns: 1,
  deployMoraleValue: 1,
}

// 帝国空中斥候：我方空中单位
const imperiumAirScout: UnitTemplate = {
  id: 'imperium-air-scout',
  name: '帝国空中斥候',
  faction: 'imperium',
  type: 'army',
  space: 'air',
  cost: 4,
  baseStats: {
    hp: 16,
    attack: 3,
    physRes: 3,
    magicRes: 0,
    moveSpeed: 1,
    range: 1,
  },
  tags: ['air', 'melee'],
  behavior: {
    movePattern: 'standard_advance',
    attackPattern: 'closest_in_row',
    targetFilter: 'enemy_only',
  },
  // 攻击范围：前方1格，对空对地都可以
  attackPatternConfig: {
    cells: [{ dr: 0, dc: 1 }],
    canHitGround: true,
    canHitAir: true,
    canHitBuilding: true,
  },
  deployDelayTurns: 0, // 部署延迟0回合
  undeployDelayTurns: 1,
  deployMoraleValue: 1,
}

// 勇气光环：法术卡牌
// 注意：法术卡牌使用 UnitTemplate 结构，但 type 为 'spell'
// 法术的效果逻辑需要在引擎中特殊处理
const courageAura: UnitTemplate = {
  id: 'courage-aura',
  name: '勇气光环',
  faction: 'imperium',
  type: 'spell',
  space: 'ground', // 法术不占据格子，但需要设置一个默认值
  cost: 3,
  baseStats: {
    hp: 0, // 法术没有生命值
    attack: 0, // 法术不造成直接伤害
    physRes: 0,
    magicRes: 0,
    moveSpeed: 0,
    range: 0,
  },
  tags: ['spell', 'buff'],
  behavior: {
    movePattern: 'no_move',
    attackPattern: 'support',
    targetFilter: 'ally_only',
  },
  deployDelayTurns: 0,
  undeployDelayTurns: 0,
  deployMoraleValue: 0, // 士气值在法术效果中计算
}

// 从测试背包创建战斗副本（传入单位模板用于生成显示名称）
const battleCards: BattleCard[] = createBattleCardsFromInventory(testInventory, [
  basicInfantry,
  artillery,
  orkBoy,
  orkPaperPlane,
  imperiumAirScout,
  courageAura,
])

// 创建牌组配置：玩家与敌人分别使用不同模板的战斗副本
const playerCardIds = battleCards
  .filter(
    (card) =>
      card.unitTemplateId === 'imperium-infantry' ||
      card.unitTemplateId === 'imperium-artillery' ||
      card.unitTemplateId === 'imperium-air-scout' ||
      card.unitTemplateId === 'courage-aura',
  )
  .map((card) => card.id)

const enemyCardIds = battleCards
  .filter((card) => card.unitTemplateId === 'ork-boy' || card.unitTemplateId === 'ork-paper-plane')
  .map((card) => card.id)

const playerDeck: DeckConfig = {
  cards: playerCardIds, // 使用战斗副本ID
}

const enemyDeck: DeckConfig = {
  // 简单示例：敌方反复使用兽人渣渣卡牌
  cards: enemyCardIds,
}

export const sampleBattleConfig: BattleConfig = {
  id: 'demo-battle-1',
  name: '帝国据点遭遇战',
  battlefield,
  resourceRule,
  playerDeck,
  enemyDeck,
  playerBase,
  enemyBase,
  victoryConditions: [{ type: 'destroy_enemy_base' }],
  defeatConditions: [{ type: 'player_base_destroyed' }],
  unitTemplates: [basicInfantry, artillery, orkBoy, orkPaperPlane, imperiumAirScout, courageAura],
  battleCards, // 使用战斗副本
  initialPlayerMorale: 100, // 初始玩家士气
  initialEnemyMorale: 100, // 初始敌人士气
  enemyFaction: 'ork', // 敌人种族（兽人）
}



