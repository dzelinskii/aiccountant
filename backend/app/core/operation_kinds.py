from typing import Literal

# Банконезависимый словарь видов операций. Коннектор каждого банка переводит
# словарь своего банка в этот; бэкенд слов конкретного банка не знает.
OperationKind = Literal[
    "purchase",  # оплата товаров и услуг
    "transfer_person",  # перевод человеку
    "transfer_self",  # между своими счетами
    "cash",  # операции с наличными
    "loan",  # платежи по кредиту
    "income",  # поступление
    "unknown",  # источник не сообщил вид
]

OPERATION_KINDS: tuple[str, ...] = (
    "purchase",
    "transfer_person",
    "transfer_self",
    "cash",
    "loan",
    "income",
    "unknown",
)

# Не экономические события: деньги лишь меняют место или форму. Из статистики
# и категоризации исключаются. unknown сюда намеренно не входит — неизвестная
# операция должна остаться видимой, а не пропасть молча.
NON_SPENDING_KINDS: tuple[str, ...] = ("transfer_self", "cash")
