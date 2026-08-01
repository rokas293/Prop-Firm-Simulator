from __future__ import annotations

import pandas as pd
import pytest

from propbt.engine.events import Order, OrderType, Side


def test_order_rejects_nonpositive_contracts():
    with pytest.raises(ValueError):
        Order(ts=pd.Timestamp.now(tz="UTC"), symbol="MES", side=Side.LONG,
              order_type=OrderType.MARKET, contracts=0)


def test_limit_order_requires_limit_price():
    with pytest.raises(ValueError):
        Order(ts=pd.Timestamp.now(tz="UTC"), symbol="MES", side=Side.LONG,
              order_type=OrderType.LIMIT, contracts=1, limit_price=None)


def test_stop_order_requires_limit_price():
    with pytest.raises(ValueError):
        Order(ts=pd.Timestamp.now(tz="UTC"), symbol="MES", side=Side.SHORT,
              order_type=OrderType.STOP, contracts=1, limit_price=None)


def test_market_order_does_not_require_limit_price():
    o = Order(ts=pd.Timestamp.now(tz="UTC"), symbol="MES", side=Side.LONG,
              order_type=OrderType.MARKET, contracts=2)
    assert o.limit_price is None


def test_sl_tp_points_must_be_positive_distances():
    with pytest.raises(ValueError):
        Order(ts=pd.Timestamp.now(tz="UTC"), symbol="MES", side=Side.LONG,
              order_type=OrderType.MARKET, contracts=1, sl_points=-5)


def test_side_sign():
    assert Side.LONG.sign == 1
    assert Side.SHORT.sign == -1
