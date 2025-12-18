import { describe, it, expect } from 'vitest'
import type { BattleState, UnitTemplate, TerrainCell } from './types'
import { calculateDamageAgainstUnit, getDamageTypeForTemplate } from './damageSystem'

function createTestTemplate(overrides: Partial<UnitTemplate> = {}): UnitTemplate {
  return {
    id: 'test-attacker',
    name: 'Test Attacker',
    faction: 'imperium',
    type: 'army',
    space: 'ground',
    cost: 0,
    baseStats: {
      hp: 10,
      attack: 10,
      physRes: 0,
      magicRes: 0,
      moveSpeed: 0,
      range: 1,
    },
    tags: [],
    behavior: {
      movePattern: 'no_move',
      attackPattern: 'closest_in_row',
      targetFilter: 'enemy_only',
    },
    deployDelayTurns: 0,
    undeployDelayTurns: 0,
    deployMoraleValue: 0,
    ...overrides,
  }
}

function createTerrainCell(): TerrainCell {
  return {
    type: 'plain',
    effects: { moveCost: 1, attackModifier: 1, damageTakenModifier: 1 },
  }
}

describe('damageSystem', () => {
  it('getDamageTypeForTemplate falls back to physical by default', () => {
    const tpl = createTestTemplate({})
    expect(getDamageTypeForTemplate(tpl)).toBe('physical')
  })

  it('calculateDamageAgainstUnit produces deterministic damage without morale/terrain/buffs', () => {
    const attacker = createTestTemplate({
      baseStats: { hp: 10, attack: 10, physRes: 0, magicRes: 0, moveSpeed: 0, range: 1 },
    })
    const defenderTemplate = createTestTemplate({
      id: 'defender',
      name: 'Defender',
      baseStats: { hp: 20, attack: 0, physRes: 0, magicRes: 0, moveSpeed: 0, range: 1 },
    })

    const state: BattleState = {
      // 对本测试来说，只需要提供 calculateDamageAgainstUnit 会访问到的字段
      config: {
        id: 'test-battle',
        name: 'Test Battle',
        battlefield: {
          rows: 1,
          cols: 1,
          playerDeployCols: [1, 1],
          enemyDeployCols: [1, 1],
          playerAdvanceMaxCol: 1,
          enemyAdvanceMaxCol: 1,
          playerBaseCol: 1,
          enemyBaseCol: 1,
        },
        resourceRule: {
          initialCommandPoints: 0,
          commandPointsPerTurn: 0,
          maxCommandPoints: 0,
          initialHandSize: 0,
          drawPerTurn: 0,
          handLimit: 0,
        },
        playerDeck: { cards: [] },
        enemyDeck: { cards: [] },
        playerBase: {
          id: 'player-base',
          owner: 'player',
          hp: 100,
          maxHp: 100,
          attack: 0,
          range: 0,
          maxTargets: 1,
          column: 1,
        },
        enemyBase: {
          id: 'enemy-base',
          owner: 'enemy',
          hp: 100,
          maxHp: 100,
          attack: 0,
          range: 0,
          maxTargets: 1,
          column: 1,
        },
        victoryConditions: [],
        defeatConditions: [],
        unitTemplates: [attacker, defenderTemplate],
        battleCards: [],
        initialPlayerMorale: 100,
        initialEnemyMorale: 100,
        enemyFaction: 'ork',
      },
      grid: [[{ groundUnitId: null, airUnitId: null, fullUnitId: null }]],
      terrain: [[createTerrainCell()]],
      units: {},
      player: {
        deck: [],
        discardPile: [],
        hand: [],
        commandPoints: 0,
      },
      enemy: {
        deck: [],
        discardPile: [],
        hand: [],
        commandPoints: 0,
      },
      playerBase: {
        id: 'player-base',
        owner: 'player',
        hp: 100,
        maxHp: 100,
        attack: 0,
        range: 0,
        maxTargets: 1,
        column: 1,
      },
      enemyBase: {
        id: 'enemy-base',
        owner: 'enemy',
        hp: 100,
        maxHp: 100,
        attack: 0,
        range: 0,
        maxTargets: 1,
        column: 1,
      },
      playerMorale: 100,
      enemyMorale: 100,
      turnNumber: 1,
      phase: 'PlayerPlanning',
      winner: null,
      pendingEvents: [],
      pendingLogEntries: [],
    }

    const defenderInstance = {
      id: 'def-1',
      templateId: defenderTemplate.id,
      owner: 'enemy',
      row: 1,
      col: 1,
      currentHp: 20,
      maxHp: 20,
      status: 'on_field' as const,
      remainingDeployTurns: 0,
      remainingUndeployTurns: 0,
      cardId: null,
      buffs: [],
      deployMoraleValue: 0,
      justDeployedThisTurn: false,
    }

    const result = calculateDamageAgainstUnit(
      state,
      attacker,
      'player',
      1,
      1,
      defenderInstance,
      { canCrit: false, ignoreMorale: true },
      {
        getTerrainCell: (_s, _r, _c) => createTerrainCell(),
        findTemplateById: (_config, id) => (id === defenderTemplate.id ? defenderTemplate : attacker),
        getMoraleForOwner: () => 100,
      },
    )

    // 在没有士气、Buff、暴击、地形修正的情况下，伤害应与基础攻击接近
    expect(result.damage).toBeGreaterThan(0)
    expect(result.damage).toBeLessThanOrEqual(attacker.baseStats.attack * 2)
  })
})

