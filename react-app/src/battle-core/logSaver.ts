/**
 * 日志自动保存功能
 * 在浏览器环境中，通过下载API保存日志文件
 */

import { BattleLog, BattleLogEntry } from './types'

/**
 * 保存日志到文件（浏览器环境）
 * @param log 战斗日志
 * @param turnNumber 回合号
 * @param format 保存格式（'json' | 'text'）
 */
export function saveLogToFile(log: BattleLog, turnNumber: number, format: 'json' | 'text' = 'json'): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
  const filename = `battle-log-turn-${turnNumber}-${timestamp}.${format === 'json' ? 'json' : 'txt'}`

  let content: string
  let mimeType: string

  if (format === 'json') {
    // 保存为JSON格式（包含完整数据）
    content = JSON.stringify(
      {
        turnNumber,
        timestamp: Date.now(),
        totalEntries: log.entries.length,
        entries: log.entries,
      },
      null,
      2,
    )
    mimeType = 'application/json'
  } else {
    // 保存为文本格式（人类可读）
    content = exportLogAsText(log, turnNumber)
    mimeType = 'text/plain'
  }

  // 创建Blob并下载
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * 导出日志为文本格式
 */
function exportLogAsText(log: BattleLog, currentTurn: number): string {
  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push(`战斗日志 - 当前回合: ${currentTurn}`)
  lines.push(`总日志条目数: ${log.entries.length}`)
  lines.push(`生成时间: ${new Date().toLocaleString('zh-CN')}`)
  lines.push('='.repeat(80))
  lines.push('')

  // 按回合分组
  const entriesByTurn = new Map<number, BattleLogEntry[]>()
  for (const entry of log.entries) {
    if (!entriesByTurn.has(entry.turnNumber)) {
      entriesByTurn.set(entry.turnNumber, [])
    }
    entriesByTurn.get(entry.turnNumber)!.push(entry)
  }

  // 按回合号排序
  const sortedTurns = Array.from(entriesByTurn.keys()).sort((a, b) => a - b)

  for (const turn of sortedTurns) {
    const entries = entriesByTurn.get(turn)!
    lines.push(`\n回合 ${turn}`)
    lines.push('-'.repeat(80))

    for (const entry of entries) {
      const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN')
      lines.push(`[${time}] [${entry.phase}] [${entry.type}] ${entry.message}`)

      // 如果有详细数据，以缩进形式显示
      if (entry.data && Object.keys(entry.data).length > 0) {
        lines.push(`  数据: ${JSON.stringify(entry.data, null, 2).split('\n').join('\n  ')}`)
      }
    }
  }

  lines.push('')
  lines.push('='.repeat(80))
  lines.push('日志结束')

  return lines.join('\n')
}

/**
 * 保存回合增量日志（只保存本回合新增的日志）
 * @param newEntries 本回合新增的日志条目
 * @param turnNumber 回合号
 */
export function saveTurnIncrementalLog(newEntries: BattleLogEntry[], turnNumber: number): void {
  if (newEntries.length === 0) return

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
  const filename = `turn-${turnNumber}-incremental-${timestamp}.json`

  const content = JSON.stringify(
    {
      turnNumber,
      timestamp: Date.now(),
      entryCount: newEntries.length,
      entries: newEntries,
    },
    null,
    2,
  )

  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

