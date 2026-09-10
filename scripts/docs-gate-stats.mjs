/**
 * Проверка того, верно ли подобран список файлов-носителей контракта в воротах
 * `docs-gate`. Список — догадка, и у неё два признака неверности:
 *
 *   широк  — метка `docs-not-needed` появляется часто: ворота требуют правки
 *            справочника там, где поведение не менялось, и их учатся обходить;
 *   узок   — справочник правят в тех PR, где ворота молчали: значит поведение
 *            живёт и в файлах, которых в списке нет.
 *
 * Своих цифр скрипт не хранит: они уже в GitHub и устареют в тот же день.
 * Выражение берётся прямо из `.github/workflows/ci.yml` — вторая копия
 * разошлась бы с воротами, а расхождение здесь означало бы проверку,
 * измеряющую не то, что стережёт CI.
 *
 * Запуск: node scripts/docs-gate-stats.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function gatePatterns() {
  const workflow = readFileSync(`${ROOT}.github/workflows/ci.yml`, 'utf-8')
  const include = workflow.match(/contract=\$\(echo "\$changed" \| grep -E '([^']+)'/)
  const exclude = workflow.match(/grep -vE '([^']+)'/)
  if (!include || !exclude) {
    throw new Error(
      'В ci.yml не найдены выражения ворот. Скрипт читает их оттуда намеренно: ' +
        'своя копия разошлась бы с тем, что проверяет CI.',
    )
  }
  return { include: new RegExp(include[1]), exclude: new RegExp(exclude[1]) }
}

const { include, exclude } = gatePatterns()
const raw = execFileSync(
  'gh',
  ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,labels,files'],
  { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
)

let fired = 0
let waived = 0
let docsWithoutGate = 0
const suspicious = []

for (const pr of JSON.parse(raw)) {
  const paths = pr.files.map((file) => file.path)
  const contract = paths.some((path) => include.test(path) && !exclude.test(path))
  const reference = paths.some((path) => path.startsWith('docs/reference/'))
  const label = pr.labels.some((item) => item.name === 'docs-not-needed')

  if (contract) fired += 1
  if (label) waived += 1
  if (reference && !contract) {
    docsWithoutGate += 1
    suspicious.push(pr.number)
  }
}

const total = JSON.parse(raw).length
console.log(`PR всего: ${total}`)
console.log(`ворота срабатывают: ${fired}`)
console.log(`снято меткой docs-not-needed: ${waived}`)
console.log(`справочник правлен мимо ворот: ${docsWithoutGate}${suspicious.length ? ` (PR ${suspicious.join(', ')})` : ''}`)
console.log('')
console.log('Метка чаще чем в каждом пятом сработавшем — список широк.')
console.log('Справочник регулярно правят мимо ворот — список узок.')
