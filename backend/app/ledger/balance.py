from datetime import datetime
from decimal import Decimal


def credit_available(
    limit: Decimal | None,
    limit_at: datetime | None,
    reported_balance: Decimal | None,
    reported_at: datetime | None,
) -> Decimal | None:
    """Сколько можно потратить по кредитной карте: лимит плюс остаток.

    Остаток кредитки — чистая позиция владельца, при долге отрицательная, так
    что сложение и даёт доступное к трате.

    None означает «считать нельзя», и это главное правило здесь: лимит и остаток
    обязаны быть замечены **одним сбором**. Иначе свежий остаток сложился бы со
    старым лимитом — подняли лимит, а в ответе банка его в этот раз не было, — и
    получилось бы достоверно выглядящее неверное число. Лучше не показать
    ничего, чем показать такое.

    Отрицательный результат не обрезается: карта сверх лимита — это факт,
    а не ошибка расчёта, и прятать его нельзя.
    """
    if limit is None or limit_at is None or reported_balance is None or reported_at is None:
        return None
    if limit_at != reported_at:
        return None
    return limit + reported_balance


def visible_balance(
    reported: Decimal | None, adjustment: Decimal, operations_sum: Decimal
) -> Decimal:
    """Остаток, который видит человек.

    Сообщённый источником остаток главенствует: банк знает лучше нас. Если
    источника нет — счёт ведётся руками, и остаток складывается из суммы
    операций и поправки, которую человек задал, когда пересчитывал деньги.
    """
    if reported is not None:
        return reported
    return adjustment + operations_sum


def adjustment_for(desired: Decimal, operations_sum: Decimal) -> Decimal:
    """Поправка, при которой видимый остаток станет равен заданному.

    Человек правит текущий остаток, а не «начальное значение»: пересчитал
    кошелёк — поставил число. Разницу с суммой операций храним мы, и в
    интерфейс это понятие не выносится.
    """
    return desired - operations_sum
