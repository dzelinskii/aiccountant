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
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// PR, не тронувший ни одного файла кода, о ширине списка ничего не говорит:
// править в нём справочник — законный и ожидаемый случай (сам справочник и
// пишется такими PR). Уликой служит только правка справочника рядом с кодом,
// которого нет в списке ворот.
const CODE_DIRS = ['backend/', 'frontend/', 'collector/', 'infra/', 'scripts/']

/** Вердикт по числам. Отдельной функцией, потому что именно он раньше врал:
 * два взаимоисключающих вывода печатались подряд при любых цифрах. */
export function verdicts({ fired, waived, blindSpots }) {
  const out = []
  if (fired > 0 && waived * 5 > fired) {
    out.push(
      `Метка снимала ворота ${waived} раз из ${fired} — чаще чем в каждом пятом. ` +
        'Список широк: ворота требуют правки там, где поведение не менялось.',
    )
  }
  if (blindSpots.length > 0) {
    out.push(
      `Справочник правили рядом с кодом мимо ворот: PR ${blindSpots.join(', ')}. ` +
        'Список узок: поведение живёт и в файлах, которых в нём нет.',
    )
  }
  if (out.length === 0) {
    out.push('Признаков перекоса нет: список файлов-носителей контракта пока подобран верно.')
  }
  return out
}

/** Счёт по выгрузке PR. Чистая — тем и проверяется. */
export function tally(prs, { include, exclude }) {
  let fired = 0
  let waived = 0
  const blindSpots = []

  for (const pr of prs) {
    const paths = pr.files.map((file) => file.path)
    const contract = paths.some((path) => include.test(path) && !exclude.test(path))
    const reference = paths.some((path) => path.startsWith('docs/reference/'))
    const touchesCode = paths.some((path) => CODE_DIRS.some((dir) => path.startsWith(dir)))
    const label = pr.labels.some((item) => item.name === 'docs-not-needed')

    if (contract) fired += 1
    if (label) waived += 1
    if (reference && !contract && touchesCode) blindSpots.push(pr.number)
  }

  return { fired, waived, blindSpots }
}

function main() {
  const raw = execFileSync(
    'gh',
    ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,labels,files'],
    { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  )
  const prs = JSON.parse(raw)
  const { fired, waived, blindSpots } = tally(prs, gatePatterns())

  console.log(`PR всего: ${prs.length}`)
  console.log(`ворота срабатывают: ${fired}`)
  console.log(`снято меткой docs-not-needed: ${waived}`)
  console.log(`справочник правлен рядом с кодом мимо ворот: ${blindSpots.length}`)
  console.log('')
  for (const line of verdicts({ fired, waived, blindSpots })) console.log(line)
}

// запуск напрямую, а не импорт ради `verdicts`/`tally`: иначе проверка вердикта
// дёргала бы сеть
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
