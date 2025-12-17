import { useEffect, useState } from 'react'
import {
  createInitialBattleState,
  deployPlayerUnit,
  endPlayerPlanningPhase,
  undeployUnit,
  debugAddUnit,
  debugRemoveUnit,
  debugDeployUnit,
  debugAddCommandPoints,
  debugAddCardToHand,
  exportBattleSnapshot,
  restoreBattleSnapshot,
  addBattleLogEntry,
  exportBattleLogAsText,
  exportBattleLogAsJSON,
} from './battle-core/engine'
import { sampleBattleConfig } from './battle-core/sampleConfig'
import type { BattleState, CardInventory, BattleLog, BattleLogEntry, BattleSnapshot } from './battle-core/types'
import { galaxies, initialInventory, type Galaxy } from './battle-core/campaignConfig'
import { ModdingPanel } from './modding/ModdingPanel'
import './index.css'

type UIMode = 'mainMenu' | 'battle'

function BattleView({
  battleState,
  setBattleState,
  battleLog,
  setBattleLog,
}: {
  battleState: BattleState
  setBattleState: (updater: (prev: BattleState) => BattleState) => void
  battleLog: BattleLog
  setBattleLog: (log: BattleLog | ((prev: BattleLog) => BattleLog)) => void
}) {
  const [selectedHandIndex, setSelectedHandIndex] = useState<number | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugTab, setDebugTab] = useState<
    'overview' | 'units' | 'commands' | 'modding' | 'snapshot' | 'log'
  >('overview')
  const [debugSelectedUnitId, setDebugSelectedUnitId] = useState<string | null>(null)

  const { battlefield, battleCards, unitTemplates, resourceRule } = battleState.config
  const grid = battleState.grid
  const [playerDeployStart, playerDeployEnd] = battlefield.playerDeployCols

  const findCardName = (cardId: string) => {
    const battleCard = battleCards.find((c) => c.id === cardId)
    if (!battleCard) return cardId
    // MVP版本：优先使用 displayName，如果没有则使用模板名称
    if (battleCard.displayName) {
      return battleCard.displayName
    }
    if (battleCard.unitTemplateId) {
      const tpl = unitTemplates.find((u) => u.id === battleCard.unitTemplateId)
      return tpl?.name ?? cardId
    }
    return cardId
  }

  const handleNextTurn = () => {
    // 先计算新状态，以便获取正确的回合号
    const nextState = endPlayerPlanningPhase(battleState!)
    // 更新状态（直接传递值，因为我们已经修改了setBattleState包装函数）
    setBattleState(nextState)
    
    // 处理待处理日志条目：将pendingLogEntries添加到BattleLog，然后清空
    let newEntries: BattleLogEntry[] = []
    if (nextState.pendingLogEntries && nextState.pendingLogEntries.length > 0) {
      setBattleLog((log) => {
        let updatedLog = log
        for (const entry of nextState.pendingLogEntries!) {
          updatedLog = addBattleLogEntry(
            updatedLog,
            entry.turnNumber,
            entry.phase,
            entry.type,
            entry.message,
            entry.data,
          )
          newEntries.push(entry)
        }
        return updatedLog
      })
      // 清空待处理日志条目（通过更新状态）
      setBattleState((prev) => ({
        ...prev,
        pendingLogEntries: [],
      }))
    } else {
      // 如果没有待处理日志，仍然记录阶段变化
      const phaseEntry = {
        turnNumber: nextState.turnNumber,
        phase: nextState.phase,
        type: 'phase_changed' as const,
        message: '进入回合结算阶段',
      }
      setBattleLog((log) => {
        const updatedLog = addBattleLogEntry(
          log,
          phaseEntry.turnNumber,
          phaseEntry.phase,
          phaseEntry.type,
          phaseEntry.message,
        )
        newEntries.push({
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          timestamp: Date.now(),
          ...phaseEntry,
        })
        return updatedLog
      })
    }

    // 自动保存本回合的增量日志
    if (newEntries.length > 0) {
      // 使用动态导入避免在非浏览器环境报错
      import('./battle-core/logSaver').then(({ saveTurnIncrementalLog }) => {
        saveTurnIncrementalLog(newEntries, nextState.turnNumber)
      }).catch(() => {
        // 如果导入失败（例如在测试环境），静默失败
        console.warn('无法保存日志文件（可能不在浏览器环境）')
      })
    }
  }

  const handleSelectCard = (index: number) => {
    setSelectedHandIndex((prev) => (prev === index ? null : index))
  }

  const handleCellClick = (rowIdx: number, colIdx: number) => {
    const row = rowIdx + 1
    const col = colIdx + 1
    const cell = grid[rowIdx][colIdx]
    // 优先选择空中单位，其次地面单位，最后全层单位（与显示逻辑一致）
    const unitId = cell.airUnitId || cell.groundUnitId || cell.fullUnitId
    const unit = unitId ? battleState.units[unitId] : null

    // 如果点击的是我方在场单位或正在反部署的单位，切换反部署状态
    if (unit && unit.owner === 'player' && (unit.status === 'on_field' || unit.status === 'undeploying') && unit.cardId) {
      setBattleState((prev) => undeployUnit(prev, unit.id))
      return
    }

    // 否则，如果选中了手牌，进行部署
    if (selectedHandIndex !== null) {
      setBattleState((prev) => deployPlayerUnit(prev, selectedHandIndex, row, col))
      setSelectedHandIndex(null)
    }
  }

  // 键盘快捷键：`（反引号）切换调试面板
  // 也可以根据需要扩展更多快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 忽略输入框等元素中的按键
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      // 反引号键（通常在数字1左侧）
      if (e.key === '`') {
        e.preventDefault()
        setDebugOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <div
      className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center py-6"
      style={{
        minHeight: '100vh',
        backgroundColor: '#020617',
        color: '#e5e7eb',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 24,
        paddingBottom: 24,
      }}
    >
      {/* 顶部标题和回合信息 */}
      <h1
        className="text-2xl font-bold mb-2"
        style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}
      >
        WH40K 战斗场景
      </h1>
      <p
        className="text-sm text-slate-400 mb-4"
        style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}
      >
        回合：{battleState.turnNumber}（阶段：{battleState.phase}）
      </p>

      {/* 顶部状态条卡片：基地 HP + 士气 + 命令点数 */}
      <div
        className="w-full max-w-3xl mb-4"
        style={{
          width: '100%',
          maxWidth: 768,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
            marginBottom: 8,
          }}
        >
          {/* 我方基地 HP */}
          <div style={{ fontSize: 12 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>我方基地 HP</div>
            <div
              style={{
                width: '100%',
                height: 10,
                borderRadius: 4,
                backgroundColor: '#111827',
                overflow: 'hidden',
                border: '1px solid #1f2937',
              }}
            >
              <div
                style={{
                  width: `${(battleState.playerBase.hp / battleState.playerBase.maxHp) * 100}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg,#22c55e,#4ade80)',
                }}
              />
            </div>
          </div>

          {/* 敌方基地 HP */}
          <div style={{ fontSize: 12, textAlign: 'right' }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>敌方基地 HP</div>
            <div
              style={{
                width: '100%',
                height: 10,
                borderRadius: 4,
                backgroundColor: '#111827',
                overflow: 'hidden',
                border: '1px solid #1f2937',
              }}
            >
              <div
                style={{
                  width: `${(battleState.enemyBase.hp / battleState.enemyBase.maxHp) * 100}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg,#f97316,#ef4444)',
                }}
              />
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
            marginBottom: 8,
          }}
        >
          {/* 我方士气 */}
          <div style={{ fontSize: 12 }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>
              我方士气 {battleState.playerMorale.toFixed(0)}/120
            </div>
            <div
              style={{
                width: '100%',
                height: 8,
                borderRadius: 4,
                backgroundColor: '#111827',
                overflow: 'hidden',
                border: '1px solid #1f2937',
              }}
            >
              <div
                style={{
                  width: `${(battleState.playerMorale / 120) * 100}%`,
                  height: '100%',
                  backgroundColor: '#3b82f6',
                }}
              />
            </div>
          </div>

          {/* 敌人士气 */}
          <div style={{ fontSize: 12, textAlign: 'right' }}>
            <div style={{ marginBottom: 4, fontWeight: 600 }}>
              敌人士气 {battleState.enemyMorale.toFixed(0)}/120
            </div>
            <div
              style={{
                width: '100%',
                height: 8,
                borderRadius: 4,
                backgroundColor: '#111827',
                overflow: 'hidden',
                border: '1px solid #1f2937',
              }}
            >
              <div
                style={{
                  width: `${(battleState.enemyMorale / 120) * 100}%`,
                  height: '100%',
                  backgroundColor: '#f97316',
                }}
              />
            </div>
          </div>
        </div>

        {/* 命令点数 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600 }}>命令点数</span>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid #22c55e',
                backgroundColor: '#022c22',
                color: '#bbf7d0',
                fontSize: 11,
              }}
            >
              {battleState.player.commandPoints} / {resourceRule.maxCommandPoints}
            </span>
          </div>
        </div>
      </div>

      {/* 中部：战场格子卡片 */}
      <div
        style={{
          border: '1px solid #334155',
          borderRadius: 8,
          backgroundColor: '#020617',
          padding: 12,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${battlefield.cols}, 36px)`,
            gridAutoRows: '36px',
            gap: 2,
            backgroundColor: '#020617',
          }}
        >
          {grid.map((row, rIdx) =>
            row.map((cell, cIdx) => {
              const isPlayerBaseCol = cIdx + 1 === battlefield.playerBaseCol
              const isEnemyBaseCol = cIdx + 1 === battlefield.enemyBaseCol
              const isBaseCol = isPlayerBaseCol || isEnemyBaseCol
              const inPlayerDeployZone = cIdx + 1 >= playerDeployStart && cIdx + 1 <= playerDeployEnd
              const terrainCell = battleState.terrain?.[rIdx]?.[cIdx]
              const terrainType = terrainCell?.type ?? 'plain'

              const terrainBg =
                terrainType === 'cover'
                  ? '#0f172a'
                  : terrainType === 'difficult'
                    ? '#713f12'
                    : terrainType === 'road'
                      ? '#0369a1'
                      : terrainType === 'water'
                        ? '#0f172a'
                        : terrainType === 'impassable'
                          ? '#7f1d1d'
                          : '#020617'

              // 查找这个格子上的单位（可能占据格子，也可能只是部署信标）
              // 检查地面、空中和全层单位
              const groundUnitId = cell.groundUnitId
              const airUnitId = cell.airUnitId
              const fullUnitId = cell.fullUnitId
              const deployingUnit = Object.values(battleState.units).find(
                (u) => u.row === rIdx + 1 && u.col === cIdx + 1 && u.status === 'in_deploy_queue',
              )
              
              // 优先显示空中单位，其次显示地面单位，最后显示全层单位
              const primaryUnitId = airUnitId || groundUnitId || fullUnitId
              const primaryUnit = primaryUnitId ? battleState.units[primaryUnitId] : deployingUnit || null
              const primaryTpl = primaryUnit && unitTemplates.find((t) => t.id === primaryUnit.templateId)
              const isPrimaryAirUnit = primaryTpl?.space === 'air'
              
              // 检查是否有第二个单位（地面+空中同时存在）
              const hasSecondUnit = (airUnitId && groundUnitId) || (airUnitId && fullUnitId) || (groundUnitId && fullUnitId)
              const secondUnitId = hasSecondUnit 
                ? (airUnitId && groundUnitId ? (primaryUnitId === airUnitId ? groundUnitId : airUnitId) : null)
                : null
              const secondUnit = secondUnitId ? battleState.units[secondUnitId] : null

              return (
                <div
                  key={`${rIdx}-${cIdx}`}
                  onClick={() => handleCellClick(rIdx, cIdx)}
                  style={{
                    width: 36,
                    height: 36,
                    boxSizing: 'border-box',
                    borderRadius: 4,
                    border: isBaseCol ? '1px solid #facc15' : '1px solid #1f2937',
                    backgroundColor: isBaseCol
                      ? '#0f172a'
                      : inPlayerDeployZone
                        ? '#020617'
                        : terrainBg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 9,
                    position: 'relative',
                    cursor: 'pointer',
                  }}
                >
                  {/* 地形标记 */}
                  {!isBaseCol && terrainType !== 'plain' && (
                    <span
                      style={{
                        position: 'absolute',
                        top: 2,
                        left: 2,
                        fontSize: 8,
                        color: '#9ca3af',
                      }}
                    >
                      {terrainType === 'cover'
                        ? '掩'
                        : terrainType === 'difficult'
                          ? '险'
                          : terrainType === 'road'
                            ? '道'
                            : terrainType === 'water'
                              ? '水'
                              : terrainType === 'impassable'
                                ? '禁'
                                : ''}
                    </span>
                  )}

                  {/* 基地 */}
                  {isPlayerBaseCol && rIdx === Math.floor(battlefield.rows / 2) && (
                    <span style={{ fontSize: 10, color: '#bbf7d0' }}>基地</span>
                  )}
                  {isEnemyBaseCol && rIdx === Math.floor(battlefield.rows / 2) && (
                    <span style={{ fontSize: 10, color: '#fecaca' }}>敌基</span>
                  )}

                  {/* 单位显示 */}
                  {!isBaseCol && primaryUnit && primaryTpl && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 2,
                        position: 'relative',
                        width: '100%',
                        height: '100%',
                      }}
                    >
                      <span style={{ fontSize: 9 }}>
                        {primaryUnit.isDeployBeacon
                          ? '信标'
                          : isPrimaryAirUnit
                            ? primaryUnit.owner === 'player'
                              ? '空'
                              : primaryUnit.owner === 'enemy'
                                ? '敌空'
                                : '中空'
                            : primaryUnit.owner === 'player'
                              ? '兵'
                              : primaryUnit.owner === 'enemy'
                                ? '敌'
                                : '中'}
                        {primaryUnit.status === 'in_deploy_queue' && !primaryUnit.isDeployBeacon && '(部)'}
                        {primaryUnit.status === 'undeploying' && '(撤)'}
                      </span>
                      <div
                        style={{
                          width: 28,
                          height: 4,
                          borderRadius: 4,
                          backgroundColor: '#1f2937',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${Math.max(5, (primaryUnit.currentHp / primaryUnit.maxHp) * 100)}%`,
                            height: '100%',
                            backgroundColor:
                              primaryUnit.status === 'in_deploy_queue'
                                ? '#facc15'
                                : primaryUnit.status === 'undeploying'
                                  ? '#fb923c'
                                  : primaryUnit.owner === 'player'
                                    ? '#22c55e'
                                    : '#ef4444',
                          }}
                        />
                      </div>
                      {/* 如果有第二个单位，在右下角显示+1 */}
                      {hasSecondUnit && (
                        <span
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            right: 0,
                            fontSize: 8,
                            color: '#9ca3af',
                            backgroundColor: '#1f2937',
                            borderRadius: 2,
                            padding: '0 2px',
                            lineHeight: 1,
                          }}
                        >
                          +1
                        </span>
                      )}
                    </div>
                  )}

                  {/* 空格子占位点 */}
                  {!isBaseCol && !primaryUnit && !cell.airUnitId && !cell.groundUnitId && (
                    <span style={{ opacity: 0.3, fontSize: 12 }}>·</span>
                  )}
                </div>
              )
            }),
          )}
        </div>
      </div>

      {/* 底部：手牌 */}
      <div
        className="mt-4 w-full max-w-3xl"
        style={{ width: '100%', maxWidth: 768, marginTop: 16 }}
      >
        <div className="mb-2 text-sm font-semibold text-slate-300" style={{ fontSize: 13 }}>
          手牌
        </div>
        <div
          className="flex flex-wrap gap-2"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
        >
          {battleState.player.hand.map((cardId, index) => (
            <button
              key={`${cardId}-${index}`}
              onClick={() => handleSelectCard(index)}
              title="点击选择卡牌，再点击战场左侧部署区域的格子进行部署"
              style={{
                padding: '4px 8px',
                borderRadius: 4,
                border: '1px solid #374151',
                backgroundColor: selectedHandIndex === index ? '#22c55e' : '#020617',
                color: selectedHandIndex === index ? '#020617' : '#e5e7eb',
                fontSize: 11,
                cursor: 'pointer',
                minWidth: 72,
                textAlign: 'center',
              }}
            >
              {findCardName(cardId)}
            </button>
          ))}
          {battleState.player.hand.length === 0 && (
            <span className="text-xs text-slate-500" style={{ fontSize: 11, color: '#6b7280' }}>
              当前手牌为空（配置问题或尚未抽牌）
            </span>
          )}
        </div>
      </div>

      {/* 底部操作与调试信息 */}
      <button
        onClick={handleNextTurn}
        className="mt-6 px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold"
        style={{
          marginTop: 16,
          padding: '6px 16px',
          borderRadius: 4,
          backgroundColor: '#22c55e',
          border: '1px solid #16a34a',
          color: '#020617',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        结束部署 / 下一回合
      </button>

      <div
        className="mt-4 w-full max-w-3xl text-xs bg-slate-900/80 border border-slate-700 rounded p-2"
        style={{
          marginTop: 16,
          width: '100%',
          maxWidth: 768,
          fontSize: 11,
          borderRadius: 8,
          border: '1px solid #334155',
          backgroundColor: '#020617',
          padding: 8,
        }}
      >
        <div className="font-semibold mb-1 text-slate-300" style={{ marginBottom: 4, fontWeight: 600 }}>
          战斗调试信息
        </div>
        <div
          className="grid grid-cols-2 gap-2"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}
        >
          <div>
            <div className="text-slate-400" style={{ color: '#9ca3af' }}>
              手牌 / 牌堆 / 弃牌
            </div>
            <div>手牌：{battleState.player.hand.length}</div>
            <div>牌堆：{battleState.player.deck.length}</div>
            <div>弃牌堆：{battleState.player.discardPile.length}</div>
          </div>
          <div>
            <div className="text-slate-400" style={{ color: '#9ca3af' }}>
              单位统计
            </div>
            <div>单位总数：{Object.keys(battleState.units).length}</div>
          </div>
        </div>
      </div>

      {/* 浮动调试面板（按 ` 键开关） */}
      {debugOpen && (
        <div
          style={{
            position: 'fixed',
            right: 16,
            bottom: 16,
            width: 360,
            maxHeight: '70vh',
            backgroundColor: '#020617',
            borderRadius: 8,
            border: '1px solid #334155',
            boxShadow: '0 10px 40px rgba(15,23,42,0.9)',
            padding: 8,
            fontSize: 11,
            display: 'flex',
            flexDirection: 'column',
            zIndex: 40,
          }}
        >
          {/* 头部：标题 + 关闭按钮 */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 12 }}>战斗调试器</div>
              <div style={{ fontSize: 10, color: '#9ca3af' }}>按 ` 键可快速开关</div>
            </div>
            <button
              onClick={() => setDebugOpen(false)}
              style={{
                border: '1px solid #4b5563',
                borderRadius: 999,
                padding: '2px 6px',
                fontSize: 10,
                backgroundColor: '#020617',
                color: '#e5e7eb',
                cursor: 'pointer',
              }}
            >
              关闭
            </button>
          </div>

          {/* Tab 切换 */}
          <div
            style={{
              display: 'flex',
              gap: 4,
              marginBottom: 6,
            }}
          >
            {[
              { id: 'overview' as const, label: '总览' },
              { id: 'units' as const, label: '单位' },
              { id: 'commands' as const, label: '指令' },
              { id: 'modding' as const, label: '模组/卡牌' },
              { id: 'snapshot' as const, label: '快照' },
              { id: 'log' as const, label: '日志' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setDebugTab(tab.id)}
                style={{
                  flex: 1,
                  padding: '3px 4px',
                  borderRadius: 4,
                  border: '1px solid #4b5563',
                  backgroundColor: debugTab === tab.id ? '#1f2937' : '#020617',
                  color: '#e5e7eb',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* 内容区域 */}
          <div
            style={{
              flex: 1,
              borderRadius: 4,
              border: '1px solid #1f2937',
              padding: 6,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              backgroundColor: '#020617',
            }}
          >
            {debugTab === 'overview' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontWeight: 600, fontSize: 11 }}>本回合总览</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  <div>
                    <div style={{ color: '#9ca3af' }}>基础</div>
                    <div>回合：{battleState.turnNumber}</div>
                    <div>阶段：{battleState.phase}</div>
                    <div>单位总数：{Object.keys(battleState.units).length}</div>
                  </div>
                  <div>
                    <div style={{ color: '#9ca3af' }}>资源</div>
                    <div>
                      CP：{battleState.player.commandPoints} / {resourceRule.maxCommandPoints}
                    </div>
                    <div>手牌：{battleState.player.hand.length}</div>
                    <div>牌堆：{battleState.player.deck.length}</div>
                  </div>
                </div>
                {/* 卡牌模板/副本分布简要统计 */}
                <div style={{ marginTop: 4, fontSize: 10 }}>
                  <div style={{ color: '#9ca3af', marginBottom: 2 }}>卡牌分布（按模板）</div>
                  {(() => {
                    const byTemplate: Record<
                      string,
                      { templateName: string; total: number; alive: number }
                    > = {}
                    for (const card of battleState.config.battleCards) {
                      const tplId = card.unitTemplateId ?? 'unknown'
                      const tpl =
                        tplId !== 'unknown'
                          ? battleState.config.unitTemplates.find((t) => t.id === tplId)
                          : undefined
                      const key = tplId
                      if (!byTemplate[key]) {
                        byTemplate[key] = {
                          templateName: tpl?.name ?? tplId,
                          total: 0,
                          alive: 0,
                        }
                      }
                      byTemplate[key].total += 1
                      if (card.currentHp > 0) byTemplate[key].alive += 1
                    }
                    const entries = Object.values(byTemplate)
                    if (entries.length === 0) {
                      return (
                        <div style={{ color: '#6b7280' }}>当前战斗配置中没有可用卡牌副本。</div>
                      )
                    }
                    return entries.map((e) => (
                      <div key={e.templateName}>
                        {e.templateName}：{e.alive}/{e.total} 张存活
                      </div>
                    ))
                  })()}
                </div>
                <div style={{ marginTop: 4, color: '#9ca3af' }}>
                  后续可在此接入“上一回合快照 / 事件日志”等更详细调试信息。
                </div>
              </div>
            )}

            {debugTab === 'modding' && (
              <ModdingPanel
                battleState={battleState}
                setBattleState={setBattleState as unknown as (
                  updater: BattleState | ((prev: BattleState) => BattleState)
                ) => void}
              />
            )}

            {debugTab === 'units' && (
              <div style={{ display: 'flex', flex: 1, gap: 4, minHeight: 0 }}>
                {/* 左侧：单位列表 */}
                <div
                  style={{
                    flex: 1,
                    borderRight: '1px solid #1f2937',
                    paddingRight: 4,
                    overflowY: 'auto',
                    maxHeight: '40vh',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 2 }}>单位列表</div>
                  {Object.values(battleState.units).map((u) => {
                    const tpl = unitTemplates.find((t) => t.id === u.templateId)
                    const isSelected = debugSelectedUnitId === u.id
                    return (
                      <div
                        key={u.id}
                        onClick={() => setDebugSelectedUnitId(u.id)}
                        style={{
                          padding: '2px 4px',
                          borderRadius: 4,
                          marginBottom: 2,
                          cursor: 'pointer',
                          backgroundColor: isSelected ? '#1f2937' : 'transparent',
                          border: isSelected ? '1px solid #4b5563' : '1px solid transparent',
                        }}
                      >
                        <div>
                          [{u.owner === 'player' ? '我' : '敌'}] {tpl?.name ?? u.templateId}
                        </div>
                        <div style={{ fontSize: 10, color: '#9ca3af' }}>
                          ID: {u.id}
                        </div>
                        <div style={{ fontSize: 10, color: '#9ca3af' }}>
                          HP {u.currentHp}/{u.maxHp} · ({u.row},{u.col}) · {u.status}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* 右侧：单位详情 */}
                <div style={{ flex: 1.2, paddingLeft: 4, overflowY: 'auto', maxHeight: '40vh' }}>
                  <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 2 }}>单位详情</div>
                  {(() => {
                    const unit = debugSelectedUnitId
                      ? battleState.units[debugSelectedUnitId]
                      : undefined
                    if (!unit) {
                      return (
                        <div style={{ fontSize: 10, color: '#9ca3af' }}>
                          点击左侧单位以查看详细属性。
                        </div>
                      )
                    }
                    const tpl = unitTemplates.find((t) => t.id === unit.templateId)
                    return (
                      <div style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div>
                          <span style={{ fontWeight: 600 }}>名称：</span>
                          {tpl?.name ?? unit.templateId}（{unit.owner === 'player' ? '我方' : '敌方'}）
                        </div>
                        <div>
                          <span style={{ fontWeight: 600 }}>位置：</span>({unit.row},{unit.col}) · 状态：
                          {unit.status}
                        </div>
                        <div>
                          <span style={{ fontWeight: 600 }}>HP：</span>
                          {unit.currentHp}/{unit.maxHp}
                        </div>
                        <div>
                          <span style={{ fontWeight: 600 }}>基础物攻 / 法攻：</span>
                          {tpl?.baseStats?.attack ?? '-'} / {tpl?.baseStats?.magicAttack ?? '0'}
                        </div>
                        {(() => {
                          // 计算实际攻击力（基础攻击 + 士气加成 + Buff加成 + 地形加成）
                          if (!tpl || !unit) return null
                          const baseAttack = tpl.baseStats.attack
                          const morale = unit.owner === 'player' ? battleState.playerMorale : battleState.enemyMorale
                          const moraleBonus = morale > 100 ? 1.1 : morale < 50 ? 0.9 : 1.0
                          const buffBonus = unit.buffs
                            .filter((b) => b.type === 'attack_up' && b.magnitude)
                            .reduce((sum, b) => sum + (b.magnitude || 0), 0)
                          const terrain = battleState.terrain?.[unit.row - 1]?.[unit.col - 1]
                          const terrainMod = terrain?.effects?.attackModifier ?? 1
                          const actualAttack = Math.floor((baseAttack + buffBonus) * moraleBonus * terrainMod)
                          return (
                            <div>
                              <span style={{ fontWeight: 600 }}>实际物攻：</span>
                              {actualAttack}
                              {moraleBonus !== 1.0 && (
                                <span style={{ fontSize: 9, color: '#9ca3af', marginLeft: 4 }}>
                                  (士气: {moraleBonus > 1 ? '+' : ''}{Math.round((moraleBonus - 1) * 100)}%)
                                </span>
                              )}
                              {buffBonus > 0 && (
                                <span style={{ fontSize: 9, color: '#9ca3af', marginLeft: 4 }}>
                                  (+{buffBonus} Buff)
                                </span>
                              )}
                              {terrainMod !== 1 && (
                                <span style={{ fontSize: 9, color: '#9ca3af', marginLeft: 4 }}>
                                  (地形: {terrainMod > 1 ? '+' : ''}{Math.round((terrainMod - 1) * 100)}%)
                                </span>
                              )}
                            </div>
                          )
                        })()}
                        <div>
                          <span style={{ fontWeight: 600 }}>物防 / 法抗：</span>
                          {tpl?.baseStats?.physRes ?? '-'} / {tpl?.baseStats?.magicRes ?? '-'}
                        </div>
                        <div>
                          <span style={{ fontWeight: 600 }}>移动力：</span>
                          {tpl?.baseStats?.moveSpeed ?? '-'}
                        </div>
                        <div>
                          <span style={{ fontWeight: 600 }}>锁定目标：</span>
                          {unit.lockedTargetId ?? '无'}
                        </div>
                        <div>
                          <span style={{ fontWeight: 600 }}>是否信标：</span>
                          {unit.isDeployBeacon ? '是' : '否'}
                        </div>
                        {/* 当前Buff效果 */}
                        {unit.buffs && unit.buffs.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ fontWeight: 600 }}>当前Buff：</span>
                            <div style={{ marginLeft: 8, fontSize: 10 }}>
                              {unit.buffs.map((buff, idx) => (
                                <div key={idx} style={{ marginTop: 2 }}>
                                  · {buff.type}
                                  {buff.magnitude !== undefined && ` +${buff.magnitude}`}
                                  {buff.remainingTurns !== undefined && ` (剩余${buff.remainingTurns}回合)`}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* 伤害历史记录 */}
                        {unit.damageHistory && unit.damageHistory.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ fontWeight: 600 }}>伤害历史：</span>
                            <div
                              style={{
                                marginLeft: 8,
                                fontSize: 9,
                                maxHeight: 120,
                                overflowY: 'auto',
                                backgroundColor: '#1e293b',
                                padding: 4,
                                borderRadius: 4,
                                marginTop: 2,
                              }}
                            >
                              {unit.damageHistory
                                .slice()
                                .reverse()
                                .slice(0, 10)
                                .map((entry, idx) => (
                                  <div key={idx} style={{ marginTop: 2, color: '#cbd5e1' }}>
                                    <div>
                                      回合{entry.turnNumber} · {entry.damageType}伤害 ·{' '}
                                      {entry.finalDamage}点
                                      {entry.isCrit && ' (暴击)'}
                                      {entry.wasSplash && ' (溅射)'}
                                    </div>
                                    <div style={{ fontSize: 8, color: '#94a3b8', marginLeft: 8 }}>
                                      基础: {entry.baseDamage.toFixed(1)} · 倍率: {entry.damageMultiplier.toFixed(2)}x · 受伤倍率: {entry.damageTakenMultiplier.toFixed(2)}x
                                    </div>
                                    {entry.sourceTemplateId && (
                                      <div style={{ fontSize: 8, color: '#64748b', marginLeft: 8 }}>
                                        来源: {entry.sourceTemplateId}
                                      </div>
                                    )}
                                  </div>
                                ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              </div>
            )}

            {debugTab === 'commands' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 11 }}>调试指令</div>
                
                {/* 单位控制 */}
                <div style={{ borderTop: '1px solid #334155', paddingTop: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 10, marginBottom: 4 }}>单位控制</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                      <select
                        id="debug-template-select"
                        style={{
                          flex: 1,
                          minWidth: 120,
                          padding: '4px 8px',
                          fontSize: 10,
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: 4,
                          color: '#e2e8f0',
                        }}
                      >
                        {unitTemplates
                          .filter((t) => t.type !== 'spell')
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                      </select>
                      <select
                        id="debug-owner-select"
                        style={{
                          padding: '4px 8px',
                          fontSize: 10,
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: 4,
                          color: '#e2e8f0',
                        }}
                      >
                        <option value="player">我方</option>
                        <option value="enemy">敌方</option>
                      </select>
                      <input
                        id="debug-row-input"
                        type="number"
                        placeholder="行"
                        min="1"
                        max={battleState.config.battlefield.rows}
                        style={{
                          width: 50,
                          padding: '4px 8px',
                          fontSize: 10,
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: 4,
                          color: '#e2e8f0',
                        }}
                      />
                      <input
                        id="debug-col-input"
                        type="number"
                        placeholder="列"
                        min="1"
                        max={battleState.config.battlefield.cols}
                        style={{
                          width: 50,
                          padding: '4px 8px',
                          fontSize: 10,
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: 4,
                          color: '#e2e8f0',
                        }}
                      />
                      <button
                        onClick={() => {
                          const templateSelect = document.getElementById('debug-template-select') as HTMLSelectElement
                          const ownerSelect = document.getElementById('debug-owner-select') as HTMLSelectElement
                          const rowInput = document.getElementById('debug-row-input') as HTMLInputElement
                          const colInput = document.getElementById('debug-col-input') as HTMLInputElement
                          const templateId = templateSelect.value
                          const owner = ownerSelect.value as 'player' | 'enemy'
                          const row = parseInt(rowInput.value)
                          const col = parseInt(colInput.value)
                          if (templateId && row && col) {
                            setBattleState((prev) => debugAddUnit(prev, templateId, owner, row, col))
                          }
                        }}
                        style={{
                          padding: '4px 12px',
                          fontSize: 10,
                          backgroundColor: '#059669',
                          border: 'none',
                          borderRadius: 4,
                          color: '#fff',
                          cursor: 'pointer',
                        }}
                      >
                        添加
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input
                        id="debug-remove-unit-input"
                        type="text"
                        placeholder="单位ID"
                        style={{
                          flex: 1,
                          padding: '4px 8px',
                          fontSize: 10,
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: 4,
                          color: '#e2e8f0',
                        }}
                      />
                      <button
                        onClick={() => {
                          const input = document.getElementById('debug-remove-unit-input') as HTMLInputElement
                          const unitId = input.value.trim()
                          if (unitId) {
                            setBattleState((prev) => debugRemoveUnit(prev, unitId))
                            input.value = ''
                          }
                        }}
                        style={{
                          padding: '4px 12px',
                          fontSize: 10,
                          backgroundColor: '#dc2626',
                          border: 'none',
                          borderRadius: 4,
                          color: '#fff',
                          cursor: 'pointer',
                        }}
                      >
                        删除
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                      <select
                        id="debug-hand-select"
                        style={{
                          flex: 1,
                          minWidth: 120,
                          padding: '4px 8px',
                          fontSize: 10,
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: 4,
                          color: '#e2e8f0',
                        }}
                      >
                          {battleState.player.hand.map((cardId, idx) => {
                            const card = battleState.config.battleCards.find((c) => c.id === cardId)
                            const template = card
                              ? unitTemplates.find((t) => t.id === card.unitTemplateId)
                              : null
                            return (
                              <option key={cardId} value={idx}>
                                {idx + 1}: {template?.name ?? cardId}
                              </option>
                            )
                          })}
                        </select>
                        <input
                          id="debug-deploy-row-input"
                        type="number"
                        placeholder="行"
                        min="1"
                        max={battleState.config.battlefield.rows}
                        style={{
                          width: 50,
                          padding: '4px 8px',
                          fontSize: 10,
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: 4,
                          color: '#e2e8f0',
                        }}
                      />
                        <input
                          id="debug-deploy-col-input"
                        type="number"
                        placeholder="列"
                        min="1"
                        max={battleState.config.battlefield.cols}
                        style={{
                          width: 50,
                          padding: '4px 8px',
                          fontSize: 10,
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: 4,
                          color: '#e2e8f0',
                        }}
                      />
                      <button
                        onClick={() => {
                          const sourceSelect = document.getElementById('debug-deploy-source-select') as HTMLSelectElement
                          const cardSelect = document.getElementById('debug-deploy-card-select') as HTMLSelectElement
                          const rowInput = document.getElementById('debug-deploy-row-input') as HTMLInputElement
                          const colInput = document.getElementById('debug-deploy-col-input') as HTMLInputElement
                          const sourceType = (sourceSelect?.value || 'hand') as 'hand' | 'deck'
                          const sourceIndex = parseInt(cardSelect?.value || '0')
                          const row = parseInt(rowInput?.value || '0')
                          const col = parseInt(colInput?.value || '0')
                          if (!isNaN(sourceIndex) && row && col) {
                            setBattleState((prev) => debugDeployUnit(prev, sourceType, sourceIndex, row, col))
                          }
                        }}
                        style={{
                          padding: '4px 12px',
                          fontSize: 10,
                          backgroundColor: '#7c3aed',
                          border: 'none',
                          borderRadius: 4,
                          color: '#fff',
                          cursor: 'pointer',
                        }}
                      >
                        部署
                      </button>
                    </div>
                  </div>
                </div>

                {/* 资源控制 */}
                <div style={{ borderTop: '1px solid #334155', paddingTop: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 10, marginBottom: 4 }}>资源控制</div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <span style={{ fontSize: 10 }}>命令点数:</span>
                    <button
                      onClick={() => setBattleState((prev) => debugAddCommandPoints(prev, 'player', 5))}
                      style={{
                        padding: '4px 12px',
                        fontSize: 10,
                        backgroundColor: '#059669',
                        border: 'none',
                        borderRadius: 4,
                        color: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      +5
                    </button>
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>
                      {battleState.player.commandPoints}/{battleState.config.resourceRule.maxCommandPoints}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {debugTab === 'snapshot' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 11 }}>快照管理</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 10, color: '#9ca3af' }}>
                    快照功能允许您保存当前战场状态，并在需要时恢复。这对于调试和问题复现非常有用。
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button
                      onClick={() => {
                        if (!battleState) return
                        const snapshot = exportBattleSnapshot(
                          battleState,
                          `回合 ${battleState.turnNumber} - ${battleState.phase}`,
                        )
                        const json = JSON.stringify(snapshot, null, 2)
                        const blob = new Blob([json], { type: 'application/json' })
                        const url = URL.createObjectURL(blob)
                        const a = document.createElement('a')
                        a.href = url
                        a.download = `battle-snapshot-turn-${battleState.turnNumber}-${Date.now()}.json`
                        a.click()
                        URL.revokeObjectURL(url)
                        alert('快照已导出！')
                      }}
                      style={{
                        padding: '6px 12px',
                        fontSize: 10,
                        backgroundColor: '#059669',
                        border: 'none',
                        borderRadius: 4,
                        color: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      导出快照
                    </button>
                    <label
                      style={{
                        padding: '6px 12px',
                        fontSize: 10,
                        backgroundColor: '#7c3aed',
                        border: 'none',
                        borderRadius: 4,
                        color: '#fff',
                        cursor: 'pointer',
                        display: 'inline-block',
                      }}
                    >
                      恢复快照
                      <input
                        type="file"
                        accept=".json"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const reader = new FileReader()
                          reader.onload = (event) => {
                            try {
                              const text = event.target?.result as string
                              const snapshot = JSON.parse(text) as BattleSnapshot
                              const restored = restoreBattleSnapshot(snapshot)
                              setBattleState(restored)
                              alert('快照已恢复！')
                            } catch (error) {
                              alert(`恢复快照失败: ${error}`)
                            }
                          }
                          reader.readAsText(file)
                          e.target.value = '' // 重置input，允许重复选择同一文件
                        }}
                      />
                    </label>
                  </div>
                  {battleState && (
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>
                      当前状态：回合 {battleState.turnNumber} · {battleState.phase} ·{' '}
                      {Object.keys(battleState.units).length} 个单位
                    </div>
                  )}
                </div>
              </div>
            )}

            {debugTab === 'log' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 11 }}>战斗日志</div>
                <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                  <button
                    onClick={() => {
                      const text = exportBattleLogAsText(battleLog)
                      const blob = new Blob([text], { type: 'text/plain' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `battle-log-${Date.now()}.txt`
                      a.click()
                      URL.revokeObjectURL(url)
                      alert('日志已导出为文本！')
                    }}
                    style={{
                      padding: '6px 12px',
                      fontSize: 10,
                      backgroundColor: '#059669',
                      border: 'none',
                      borderRadius: 4,
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    导出为文本
                  </button>
                  <button
                    onClick={() => {
                      const json = exportBattleLogAsJSON(battleLog)
                      const blob = new Blob([json], { type: 'application/json' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `battle-log-${Date.now()}.json`
                      a.click()
                      URL.revokeObjectURL(url)
                      alert('日志已导出为JSON！')
                    }}
                    style={{
                      padding: '6px 12px',
                      fontSize: 10,
                      backgroundColor: '#059669',
                      border: 'none',
                      borderRadius: 4,
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    导出为JSON
                  </button>
                  <button
                    onClick={() => {
                      setBattleLog({ entries: [], maxEntries: 1000 })
                      alert('日志已清空！')
                    }}
                    style={{
                      padding: '6px 12px',
                      fontSize: 10,
                      backgroundColor: '#dc2626',
                      border: 'none',
                      borderRadius: 4,
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    清空日志
                  </button>
                </div>
                <div
                  style={{
                    maxHeight: '50vh',
                    overflowY: 'auto',
                    border: '1px solid #334155',
                    borderRadius: 4,
                    padding: 8,
                    backgroundColor: '#0f172a',
                    fontSize: 10,
                  }}
                >
                  {battleLog.entries.length === 0 ? (
                    <div style={{ color: '#9ca3af' }}>暂无日志条目</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {battleLog.entries.map((entry) => (
                        <div
                          key={entry.id}
                          style={{
                            padding: 4,
                            borderRadius: 2,
                            backgroundColor: '#1e293b',
                            borderLeft: `3px solid ${
                              entry.type === 'error'
                                ? '#dc2626'
                                : entry.type === 'unit_killed' || entry.type === 'base_destroyed'
                                  ? '#f59e0b'
                                  : entry.type === 'unit_attacked' || entry.type === 'unit_damaged'
                                    ? '#ef4444'
                                    : entry.type === 'skill_used' || entry.type === 'buff_applied'
                                      ? '#3b82f6'
                                      : '#6b7280'
                            }`,
                          }}
                        >
                          <div style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
                            <span style={{ color: '#9ca3af', fontSize: 9 }}>
                              回合 {entry.turnNumber}
                            </span>
                            <span style={{ color: '#9ca3af', fontSize: 9 }}>·</span>
                            <span style={{ color: '#9ca3af', fontSize: 9 }}>{entry.phase}</span>
                            <span style={{ color: '#9ca3af', fontSize: 9 }}>·</span>
                            <span
                              style={{
                                color:
                                  entry.type === 'error'
                                    ? '#dc2626'
                                    : entry.type === 'unit_killed'
                                      ? '#f59e0b'
                                      : '#6b7280',
                                fontSize: 9,
                                fontWeight: 600,
                              }}
                            >
                              {entry.type}
                            </span>
                            <span style={{ color: '#9ca3af', fontSize: 9, marginLeft: 'auto' }}>
                              {new Date(entry.timestamp).toLocaleTimeString('zh-CN')}
                            </span>
                          </div>
                          <div style={{ marginTop: 2, color: '#e5e7eb' }}>{entry.message}</div>
                          {entry.data && Object.keys(entry.data).length > 0 && (
                            <div
                              style={{
                                marginTop: 4,
                                padding: 4,
                                backgroundColor: '#0f172a',
                                borderRadius: 2,
                                fontSize: 9,
                                color: '#9ca3af',
                                fontFamily: 'monospace',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                              }}
                            >
                              {JSON.stringify(entry.data, null, 2)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 9, color: '#9ca3af' }}>
                  共 {battleLog.entries.length} 条日志
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function App() {
  const [mode, setMode] = useState<UIMode>('mainMenu')
  const [battleState, setBattleState] = useState<BattleState | null>(null)
  const [battleLog, setBattleLog] = useState<BattleLog>({ entries: [], maxEntries: 1000 })
  const [selectedGalaxyId, setSelectedGalaxyId] = useState<string | null>(galaxies[0]?.id ?? null)
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(
    galaxies[0]?.chapters[0]?.id ?? null,
  )
  const [selectedBattleId, setSelectedBattleId] = useState<string | null>(
    galaxies[0]?.chapters[0]?.battles[0]?.id ?? null,
  )
  const [inventory] = useState<CardInventory[]>(() => initialInventory)

  const startBattle = () => {
    // MVP：仅支持当前选中星系/章节中的第一个战役（0.1 Test）
    const currentGalaxy: Galaxy | undefined =
      galaxies.find((g) => g.id === selectedGalaxyId) ?? galaxies[0]
    const currentChapter =
      currentGalaxy?.chapters.find((ch) => ch.id === selectedChapterId) ??
      currentGalaxy?.chapters[0]
    const currentBattle =
      currentChapter?.battles.find((b) => b.id === selectedBattleId) ??
      currentChapter?.battles[0]

    if (!currentBattle) {
      return
    }

    const battleConfig = sampleBattleConfig // 目前只有一个 sampleBattleConfig 与 0.1 Test 绑定
    const next = createInitialBattleState(battleConfig)
    setBattleState(next)
    setMode('battle')
  }

  const returnToMenu = () => {
    setMode('mainMenu')
  }

  if (mode === 'mainMenu') {
    const currentGalaxy: Galaxy | undefined =
      galaxies.find((g) => g.id === selectedGalaxyId) ?? galaxies[0]
    const currentChapter =
      currentGalaxy?.chapters.find((ch) => ch.id === selectedChapterId) ??
      currentGalaxy?.chapters[0]
    const currentBattle =
      currentChapter?.battles.find((b) => b.id === selectedBattleId) ??
      currentChapter?.battles[0]

    return (
      <div
        className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center py-6"
        style={{
          minHeight: '100vh',
          backgroundColor: '#020617',
          color: '#e5e7eb',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 24,
          paddingBottom: 24,
        }}
      >
        <h1 className="text-2xl font-bold mb-4" style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>
          WH40K 战役总览
        </h1>

        <div
          className="w-full max-w-4xl flex flex-col gap-4"
          style={{ width: '100%', maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 16 }}
        >
          {/* 星系 / 章节 / 战役 列表（文字） */}
          <div
            className="grid grid-cols-2 gap-4"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 16,
            }}
          >
            <div
              className="border border-slate-700 rounded bg-slate-900 p-3"
              style={{
                border: '1px solid #334155',
                borderRadius: 8,
                backgroundColor: '#020617',
                padding: 12,
              }}
            >
              <div className="font-semibold mb-2 text-slate-300">星系列表</div>
              <ul className="space-y-1 text-sm">
                {galaxies.map((g) => (
                  <li key={g.id}>
                    <button
                      className={`w-full text-left px-2 py-1 rounded ${
                        currentGalaxy?.id === g.id
                          ? 'bg-emerald-600 text-slate-900'
                          : 'bg-slate-800 hover:bg-slate-700'
                      }`}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '4px 8px',
                        borderRadius: 4,
                        backgroundColor: currentGalaxy?.id === g.id ? '#22c55e' : '#020617',
                        color: currentGalaxy?.id === g.id ? '#020617' : '#e5e7eb',
                        border: '1px solid #4b5563',
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        setSelectedGalaxyId(g.id)
                        setSelectedChapterId(g.chapters[0]?.id ?? null)
                        setSelectedBattleId(g.chapters[0]?.battles[0]?.id ?? null)
                      }}
                    >
                      {g.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div
              className="border border-slate-700 rounded bg-slate-900 p-3"
              style={{
                border: '1px solid #334155',
                borderRadius: 8,
                backgroundColor: '#020617',
                padding: 12,
              }}
            >
              <div className="font-semibold mb-2 text-slate-300">章节列表</div>
              <ul className="space-y-1 text-sm">
                {currentGalaxy?.chapters.map((ch) => (
                  <li key={ch.id}>
                    <button
                      className={`w-full text-left px-2 py-1 rounded ${
                        currentChapter?.id === ch.id
                          ? 'bg-emerald-600 text-slate-900'
                          : 'bg-slate-800 hover:bg-slate-700'
                      }`}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '4px 8px',
                        borderRadius: 4,
                        backgroundColor: currentChapter?.id === ch.id ? '#22c55e' : '#020617',
                        color: currentChapter?.id === ch.id ? '#020617' : '#e5e7eb',
                        border: '1px solid #4b5563',
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        setSelectedChapterId(ch.id)
                        setSelectedBattleId(ch.battles[0]?.id ?? null)
                      }}
                    >
                      {ch.name}
                    </button>
                  </li>
                )) ?? <li className="text-slate-500">当前星系暂无章节</li>}
              </ul>
            </div>
          </div>

          {/* 右侧：章节简介 + 背包（文字列表） */}
          <div
            className="grid grid-cols-2 gap-4"
            style={{
              display: 'grid',
              gridTemplateColumns: '1.2fr 1fr',
              gap: 16,
            }}
          >
            <div
              className="border border-slate-700 rounded bg-slate-900 p-3 text-sm"
              style={{
                border: '1px solid #334155',
                borderRadius: 8,
                backgroundColor: '#020617',
                padding: 12,
                fontSize: 13,
              }}
            >
              <div className="font-semibold mb-1 text-slate-300">章节 / 战役 简介</div>
              <div className="text-slate-200 mb-1">{currentChapter?.name ?? '未选择章节'}</div>
              <div className="text-slate-400 text-xs whitespace-pre-line">
                {currentChapter?.description ??
                  '请选择一章战役。当前仅有“初始星系-教程章节-战役 0.1 Test”示例。'}
              </div>
              <div className="mt-2 text-xs text-slate-400">
                当前战役：{currentBattle?.name ?? '未选择战役'}
              </div>
              <button
                className="mt-3 px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold"
                style={{
                  marginTop: 12,
                  padding: '4px 12px',
                  borderRadius: 4,
                  backgroundColor: '#22c55e',
                  border: '1px solid #16a34a',
                  color: '#020617',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: currentChapter ? 'pointer' : 'not-allowed',
                  opacity: currentChapter ? 1 : 0.5,
                }}
                onClick={startBattle}
                disabled={!currentChapter}
              >
                进入战斗
              </button>
            </div>

            <div
              className="border border-slate-700 rounded bg-slate-900 p-3 text-sm"
              style={{
                border: '1px solid #334155',
                borderRadius: 8,
                backgroundColor: '#020617',
                padding: 12,
                fontSize: 13,
              }}
            >
              <div className="font-semibold mb-1 text-slate-300">背包（测试数据）</div>
              <div className="text-slate-400 text-xs mb-1">
                当前卡牌数量：{inventory.length}（战役外原始数据，仅文字展示）
              </div>
              <div
                className="max-h-40 overflow-auto text-xs border border-slate-800 rounded p-1 bg-slate-950/60"
                style={{
                  maxHeight: 160,
                  overflowY: 'auto',
                  fontSize: 12,
                  border: '1px solid #1f2937',
                  borderRadius: 4,
                  padding: 4,
                  backgroundColor: '#020617',
                }}
              >
                {inventory.map((card) => (
                  <div
                    key={card.id}
                    className="flex justify-between gap-2 border-b border-slate-800/50 py-0.5"
                  >
                    <span className="truncate">{card.unitTemplateId ?? card.id}</span>
                    <span className="text-slate-400">
                      HP {card.currentHp}/{card.maxHp}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 主菜单调试控制台 */}
          <div
            className="border border-slate-700 rounded bg-slate-900 p-3 text-xs"
            style={{
              border: '1px solid #334155',
              borderRadius: 8,
              backgroundColor: '#020617',
              padding: 12,
              fontSize: 12,
            }}
          >
            <div className="font-semibold mb-1 text-slate-300">主菜单调试控制台</div>
            <div>当前星系：{currentGalaxy?.id}</div>
            <div>当前章节：{currentChapter?.id}</div>
            <div>当前战役：{currentBattle?.id}</div>
            <div>当前背包卡牌数：{inventory.length}</div>
          </div>
        </div>
      </div>
    )
  }

  if (!battleState) {
    // 理论上不会到这里，仅作为安全兜底
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <button
          onClick={startBattle}
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold"
        >
          初始化战斗
        </button>
      </div>
    )
  }

  return (
    <>
      <BattleView
        battleState={battleState}
        setBattleState={(updater) => {
          if (typeof updater === 'function') {
            setBattleState((prev) => updater(prev!))
          } else {
            setBattleState(updater)
          }
        }}
        battleLog={battleLog}
        setBattleLog={setBattleLog}
      />
      {/* 返回主菜单按钮固定在右上角 */}
      <button
        onClick={returnToMenu}
        className="fixed top-3 right-3 px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs border border-slate-600"
      >
        返回主菜单
      </button>
    </>
  )
}

export default App
