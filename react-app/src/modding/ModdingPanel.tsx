import { useMemo, useState } from 'react'
import type { BattleCard, BattleState, UnitTemplate } from '../battle-core/types'

type DeckTarget = 'playerHand' | 'playerDeck' | 'enemyHand' | 'enemyDeck'

function safeJsonParse<T>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function ModdingPanel(props: {
  battleState: BattleState
  setBattleState: (updater: BattleState | ((prev: BattleState) => BattleState)) => void
}) {
  const { battleState, setBattleState } = props

  const [templateJson, setTemplateJson] = useState<string>(() =>
    JSON.stringify(
      {
        id: 'mod-imperium-sniper',
        name: '帝国狙击手(自定义)',
        faction: 'imperium',
        type: 'army',
        space: 'ground',
        cost: 3,
        baseStats: { hp: 12, attack: 10, physRes: 1, magicRes: 0, moveSpeed: 1, range: 4 },
        tags: ['infantry', 'ranged'],
        behavior: { movePattern: 'standard_advance', attackPattern: 'closest_in_row', targetFilter: 'enemy_only' },
        deployDelayTurns: 1,
        undeployDelayTurns: 1,
        deployMoraleValue: 1,
      },
      null,
      2,
    ),
  )

  const [cardTemplateId, setCardTemplateId] = useState<string>('mod-imperium-sniper')
  const [cardCount, setCardCount] = useState<number>(1)
  const [deckTarget, setDeckTarget] = useState<DeckTarget>('playerHand')
  const [statusMsg, setStatusMsg] = useState<string>('')

  const templateIds = useMemo(
    () => battleState.config.unitTemplates.map((t) => ({ id: t.id, name: t.name })),
    [battleState.config.unitTemplates],
  )

  const exportBundle = useMemo(() => {
    return JSON.stringify(
      {
        version: 1,
        exportedAt: Date.now(),
        unitTemplates: battleState.config.unitTemplates,
        battleCards: battleState.config.battleCards,
      },
      null,
      2,
    )
  }, [battleState.config.unitTemplates, battleState.config.battleCards])

  function upsertTemplate(tpl: UnitTemplate) {
    setBattleState((prev) => {
      const existingIdx = prev.config.unitTemplates.findIndex((t) => t.id === tpl.id)
      const nextTemplates =
        existingIdx >= 0
          ? prev.config.unitTemplates.map((t) => (t.id === tpl.id ? tpl : t))
          : [...prev.config.unitTemplates, tpl]
      return { ...prev, config: { ...prev.config, unitTemplates: nextTemplates } }
    })
  }

  function addBattleCards(templateId: string, count: number, target: DeckTarget) {
    setBattleState((prev) => {
      const tpl = prev.config.unitTemplates.find((t) => t.id === templateId)
      if (!tpl) return prev

      const newCards: BattleCard[] = []
      for (let i = 0; i < count; i++) {
        const sourceCardId = makeId('inv-mod')
        newCards.push({
          id: makeId('battle-mod'),
          sourceCardId,
          type: 'unit',
          unitTemplateId: tpl.id,
          maxHp: tpl.baseStats.hp,
          currentHp: tpl.baseStats.hp,
          displayName: `${tpl.name} #${prev.config.battleCards.filter((c) => c.unitTemplateId === tpl.id).length + i + 1}`,
        })
      }

      const nextConfig = { ...prev.config, battleCards: [...prev.config.battleCards, ...newCards] }
      const newIds = newCards.map((c) => c.id)

      const next = { ...prev, config: nextConfig }
      if (target === 'playerHand') next.player = { ...next.player, hand: [...next.player.hand, ...newIds] }
      if (target === 'playerDeck') next.player = { ...next.player, deck: [...next.player.deck, ...newIds] }
      if (target === 'enemyHand') next.enemy = { ...next.enemy, hand: [...next.enemy.hand, ...newIds] }
      if (target === 'enemyDeck') next.enemy = { ...next.enemy, deck: [...next.enemy.deck, ...newIds] }

      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, minHeight: 0 }}>
      <div style={{ fontWeight: 600, fontSize: 11 }}>模组 / 模板与卡牌生成</div>
      <div style={{ color: '#9ca3af', fontSize: 10 }}>
        这是一个 MVP 编辑器：支持导入/更新单位模板，并按模板一键生成战斗卡牌副本，直接注入手牌或牌堆。
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 11 }}>1) 模板（UnitTemplate JSON）</div>
          <textarea
            value={templateJson}
            onChange={(e) => setTemplateJson(e.target.value)}
            style={{
              width: '100%',
              minHeight: 140,
              flex: 1,
              resize: 'vertical',
              background: '#0b1220',
              color: '#e5e7eb',
              border: '1px solid #1f2937',
              borderRadius: 4,
              padding: 6,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: 10,
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => {
                const parsed = safeJsonParse<UnitTemplate>(templateJson)
                if (!parsed.ok) {
                  setStatusMsg(`模板 JSON 解析失败：${parsed.error}`)
                  return
                }
                upsertTemplate(parsed.value)
                setCardTemplateId(parsed.value.id)
                setStatusMsg(`模板已添加/更新：${parsed.value.id}`)
              }}
              style={{
                border: '1px solid #4b5563',
                borderRadius: 6,
                padding: '4px 8px',
                background: '#111827',
                color: '#e5e7eb',
                cursor: 'pointer',
              }}
            >
              添加/更新模板
            </button>
            <button
              onClick={() => {
                const tpl = battleState.config.unitTemplates.find((t) => t.id === cardTemplateId)
                if (!tpl) {
                  setStatusMsg(`找不到模板：${cardTemplateId}`)
                  return
                }
                setTemplateJson(JSON.stringify(tpl, null, 2))
                setStatusMsg(`已载入模板：${tpl.id}`)
              }}
              style={{
                border: '1px solid #4b5563',
                borderRadius: 6,
                padding: '4px 8px',
                background: '#020617',
                color: '#e5e7eb',
                cursor: 'pointer',
              }}
            >
              载入现有模板到编辑器
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 11 }}>2) 生成卡牌（BattleCard 副本）</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              模板：
              <select
                value={cardTemplateId}
                onChange={(e) => setCardTemplateId(e.target.value)}
                style={{ background: '#0b1220', color: '#e5e7eb', border: '1px solid #1f2937', borderRadius: 4 }}
              >
                {templateIds.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.id})
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              数量：
              <input
                type="number"
                value={cardCount}
                min={1}
                max={20}
                onChange={(e) => setCardCount(Number(e.target.value))}
                style={{ width: 64, background: '#0b1220', color: '#e5e7eb', border: '1px solid #1f2937', borderRadius: 4 }}
              />
            </label>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              注入到：
              <select
                value={deckTarget}
                onChange={(e) => setDeckTarget(e.target.value as DeckTarget)}
                style={{ background: '#0b1220', color: '#e5e7eb', border: '1px solid #1f2937', borderRadius: 4 }}
              >
                <option value="playerHand">我方手牌</option>
                <option value="playerDeck">我方牌堆</option>
                <option value="enemyHand">敌方手牌</option>
                <option value="enemyDeck">敌方牌堆</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <button
              onClick={() => {
                const tpl = battleState.config.unitTemplates.find((t) => t.id === cardTemplateId)
                if (!tpl) {
                  setStatusMsg(`找不到模板：${cardTemplateId}`)
                  return
                }
                const n = Number.isFinite(cardCount) && cardCount > 0 ? Math.floor(cardCount) : 1
                addBattleCards(tpl.id, n, deckTarget)
                setStatusMsg(`已生成 ${n} 张卡牌并注入：${deckTarget}`)
              }}
              style={{
                border: '1px solid #4b5563',
                borderRadius: 6,
                padding: '4px 8px',
                background: '#1f2937',
                color: '#e5e7eb',
                cursor: 'pointer',
              }}
            >
              生成并注入
            </button>
            <button
              onClick={() => {
                navigator.clipboard
                  ?.writeText(exportBundle)
                  .then(() => setStatusMsg('已复制当前配置（unitTemplates + battleCards）到剪贴板'))
                  .catch(() => setStatusMsg('复制失败（浏览器可能未授权剪贴板权限）'))
              }}
              style={{
                border: '1px solid #4b5563',
                borderRadius: 6,
                padding: '4px 8px',
                background: '#020617',
                color: '#e5e7eb',
                cursor: 'pointer',
              }}
            >
              复制当前配置 JSON
            </button>
          </div>

          <div style={{ marginTop: 4, fontSize: 10, color: statusMsg.includes('失败') ? '#fca5a5' : '#9ca3af' }}>
            {statusMsg || ' '}
          </div>

          <div style={{ marginTop: 6, borderTop: '1px solid #1f2937', paddingTop: 6, minHeight: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 11 }}>3) 导入/导出（MVP）</div>
            <div style={{ color: '#9ca3af', fontSize: 10 }}>
              导出：复制当前配置 JSON。导入：把 JSON 粘贴到编辑器，然后点“添加/更新模板”。
              （下一步我们会把“模板 + 背包库存 CardInventory + 战役存档”完整串起来。）
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


