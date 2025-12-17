import type { CardInventory } from './types'
import { sampleBattleConfig } from './sampleConfig'
import { testInventory } from './testInventory'

// ==========================
// 星系-章节-战役 组织结构（MVP）
// ==========================

// 单场战斗节点（战役关卡）
export interface GalaxyBattle {
  id: string
  name: string
  description?: string
  battleConfigId: string
}

// 星系内的章节
export interface GalaxyChapter {
  id: string
  name: string
  description?: string
  battles: GalaxyBattle[]
}

// 顶层：星系（决定可遇到的种族、战役走向）
export interface Galaxy {
  id: string
  name: string
  description?: string
  chapters: GalaxyChapter[]
}

// 当前仅实现一个最简单的结构：
// 初始星系（Initial Sector） - 教程章节（Tutorial） - 战役 0.1 Test（绑定 sampleBattleConfig）
export const galaxies: Galaxy[] = [
  {
    id: 'galaxy-initial',
    name: '初始星系：卡迪安前线',
    description: '用于调试战斗引擎的示例星系。',
    chapters: [
      {
        id: 'chapter-tutorial',
        name: '教程章节',
        description: '基础部署、溅射、地形与士气的教程章节。',
        battles: [
          {
            id: 'battle-0-1-test',
            name: '战役 0.1 Test',
            description: '当前的 sampleBattleConfig，用作战斗场景入口。',
            battleConfigId: sampleBattleConfig.id,
          },
        ],
      },
    ],
  },
]

// MVP：直接导出测试用背包作为“全局背包”（后续会被星系内仓库/背包系统替代或拆分）
export const initialInventory: CardInventory[] = testInventory

