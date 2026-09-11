<!-- Этот файл создан генератором, не правьте руками: правки затрёт следующая перегенерация, а CI её потребует. Источник — collector/scripts/gen-reference.ts -->

# Коллектор: перевод словарей Альфа-Банка

Слова банка не покидают его плагина: здесь они переводятся в общий словарь
приложения. У Альфы вид операции собирается из направления (income/purchase)
и уточняется по operationType (у переводов) и category.id.

## Вид операции (operationType) → вид

- `BASE_OUTGOING_TRANSFER` → `transfer_person`
- `CARD2CARD_TRANSFER` → `transfer_person`
- `FAST_PAYMENT_SYSTEM_TRANSFER` → `transfer_person`
- `FAST_PAYMENT_SYSTEM_TRANSFER_ME2ME` → `transfer_self`

## Категория банка (category.id) → вид

- `00052` → `transfer_person`
- `50009` → `transfer_person`

## Виды, намеренно не уточнённые в v1

- `cash` — снятие/внесение наличных — не встретилось на разведке с надёжным признаком; до живого прогона идёт по направлению
- `loan` — платёж по кредиту — то же; вид loan добавим, когда увидим признак вживую

Операция с незнакомыми operationType и category.id получает вид по
направлению: приход — `income`, расход — `purchase`. Она остаётся видимой,
попадает в статистику, счётчик в выводе сбора о ней сообщает.
