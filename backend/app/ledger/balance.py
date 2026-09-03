from decimal import Decimal


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
