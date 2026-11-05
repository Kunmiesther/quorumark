"""Explicit live mandate settings; invalid values never select a default."""
from decimal import Decimal, InvalidOperation


def configured_leverage(value, *, maximum):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
        if not number.is_finite() or number != number.to_integral_value() or not 1 <= number <= maximum:
            return None
        return int(number)
    except (InvalidOperation, TypeError, ValueError):
        return None
