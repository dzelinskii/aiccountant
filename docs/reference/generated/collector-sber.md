<!-- Этот файл создан генератором, не правьте руками: правки затрёт следующая перегенерация, а CI её потребует. Источник — collector/scripts/gen-reference.ts -->

# Коллектор: перевод словарей Сбербанка

Слова банка не покидают его плагина: здесь они переводятся в общий словарь
приложения. У Сбербанка вид операции несёт одно поле `form`, тогда как у
Т-Банка — группа с уточняющей подгруппой.

## Вид операции банка → вид

- `ExtCardCashIn` → `cash`
- `ExtCardCashOut` → `cash`
- `ExtCardPayment` → `purchase`
- `ExtCardPaymentRefund` → `purchase`
- `ExtCardTransferIn` → `transfer_person`
- `ExtCardTransferOut` → `transfer_person`
- `P2PSBPInTransfer` → `transfer_person`
- `UfsExtCardFee` → `purchase`
- `UfsExtMMPLSBPOutNAcptTransfer` → `transfer_person`
- `UfsOutTransfer` → `transfer_person`
- `UfsP2PSBPOutTransfer` → `transfer_person`
- `UfsQRSBP` → `purchase`
- `UfsTransferBankPartnerPhone` → `transfer_person`
- `UfsTransferSelf` → `transfer_self`

## Виды, намеренно не переведённые

- `ExtCardOtherOut` — буквально «прочее списание»; живой прогон дал 14 таких записей за месяц, все с MCC — то есть похожи на покупки, но подтверждения этому нет

Такая операция получает вид `unknown`: она остаётся видимой, попадает в
статистику, и счётчик в выводе сбора о ней сообщает.
