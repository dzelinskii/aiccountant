from typing import Literal, NamedTuple, get_args

# Банконезависимый словарь подсказок о категории. Коннектор каждого банка
# переводит в него слова своего банка; бэкенд про «Супермаркеты» и MCC 5411
# не знает — по той же причине, по которой не знает про PAY и INTERNAL
# (см. app/core/operation_kinds.py).
#
# Словарь намеренно грубее банковских справочников: у Т-Банка их 90, и перевод
# один к одному завёл бы в дереве человека «Duty Free» и «Металлы в слитках».
CategoryHint = Literal[
    # еда
    "groceries",
    "dining",
    # транспорт
    "taxi",
    "transit",
    "fuel",
    "parking",
    "car",
    "car_rental",
    "travel",
    # жильё
    "utilities",
    "home",
    # связь
    "mobile",
    "internet",
    # развлечения
    "entertainment",
    "cinema",
    "music",
    "sports",
    # здоровье
    "pharmacy",
    "medical",
    "beauty",
    # прочее
    "clothing",
    "jewelry",
    "electronics",
    "marketplace",
    "pets",
    "kids",
    "gifts",
    "education",
    "charity",
    "taxes",
    "bank_fees",
    "services",
    "ecosystem",
    # доходы
    "salary",
    "benefits",
    "interest",
    "cashback",
]

# Тот же словарь значениями — для проверок на входе. Выводится из Literal,
# чтобы список не разъезжался с типом.
CATEGORY_HINTS: tuple[str, ...] = get_args(CategoryHint)


class HintTarget(NamedTuple):
    """Куда садится подсказка в дереве по умолчанию.

    `sub is None` — подсказка садится в самого родителя: дробить «Зарплату»
    не на что, и лишний уровень там был бы шумом.
    """

    parent: str
    sub: str | None
    kind: str


# Родители — категории из дефолтного набора (app/ledger/repository.py).
# Имена подкатегорий наши, а не банковские: словарь Т-Банка в дерево человека
# не протекает.
HINT_DEFAULTS: dict[str, HintTarget] = {
    "groceries": HintTarget("Еда", "Продукты", "expense"),
    "dining": HintTarget("Еда", "Кафе и рестораны", "expense"),
    "taxi": HintTarget("Транспорт", "Такси", "expense"),
    "transit": HintTarget("Транспорт", "Общественный транспорт", "expense"),
    "fuel": HintTarget("Транспорт", "Заправки", "expense"),
    "parking": HintTarget("Транспорт", "Парковка и дороги", "expense"),
    "car": HintTarget("Транспорт", "Автомобиль", "expense"),
    "car_rental": HintTarget("Транспорт", "Аренда и каршеринг", "expense"),
    "travel": HintTarget("Транспорт", "Поездки", "expense"),
    "utilities": HintTarget("Жильё", "ЖКХ", "expense"),
    "home": HintTarget("Жильё", "Ремонт и обустройство", "expense"),
    "mobile": HintTarget("Связь", "Мобильная связь", "expense"),
    "internet": HintTarget("Связь", "Интернет и ТВ", "expense"),
    "entertainment": HintTarget("Развлечения", "Досуг", "expense"),
    "cinema": HintTarget("Развлечения", "Кино", "expense"),
    "music": HintTarget("Развлечения", "Музыка и подписки", "expense"),
    "sports": HintTarget("Развлечения", "Спорт", "expense"),
    "pharmacy": HintTarget("Здоровье", "Аптеки", "expense"),
    "medical": HintTarget("Здоровье", "Медицина", "expense"),
    "beauty": HintTarget("Здоровье", "Красота", "expense"),
    "clothing": HintTarget("Прочее", "Одежда и обувь", "expense"),
    "jewelry": HintTarget("Прочее", "Украшения", "expense"),
    "electronics": HintTarget("Прочее", "Техника", "expense"),
    "marketplace": HintTarget("Прочее", "Маркетплейсы", "expense"),
    "pets": HintTarget("Прочее", "Животные", "expense"),
    "kids": HintTarget("Прочее", "Детское", "expense"),
    "gifts": HintTarget("Прочее", "Подарки и цветы", "expense"),
    "education": HintTarget("Прочее", "Образование", "expense"),
    "charity": HintTarget("Прочее", "Благотворительность", "expense"),
    "taxes": HintTarget("Прочее", "Налоги и штрафы", "expense"),
    "bank_fees": HintTarget("Прочее", "Услуги банка", "expense"),
    "services": HintTarget("Прочее", "Услуги", "expense"),
    "ecosystem": HintTarget("Прочее", "Экосистемы", "expense"),
    "salary": HintTarget("Зарплата", None, "income"),
    "benefits": HintTarget("Прочие доходы", "Пособия и пенсии", "income"),
    "interest": HintTarget("Прочие доходы", "Проценты и дивиденды", "income"),
    "cashback": HintTarget("Прочие доходы", "Бонусы", "income"),
}
