from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Reservation:
    request_id: str
    sku: str
    quantity: int


class Inventory:
    def __init__(self, stock: dict[str, int]) -> None:
        self._available = dict(stock)
        self._reservations: dict[str, Reservation] = {}

    def available(self, sku: str) -> int:
        return self._available.get(sku, 0)

    def reserve(self, request_id: str, sku: str, quantity: int) -> Reservation:
        if not request_id:
            raise ValueError("request_id must not be empty")
        if quantity <= 0:
            raise ValueError("quantity must be positive")

        available = self.available(sku)
        if quantity > available:
            raise ValueError(
                f"insufficient stock for {sku}: requested {quantity}, available {available}"
            )

        reservation = Reservation(request_id=request_id, sku=sku, quantity=quantity)
        self._available[sku] = available - quantity
        self._reservations[request_id] = reservation
        return reservation

    def reservation(self, request_id: str) -> Reservation | None:
        return self._reservations.get(request_id)
