from __future__ import annotations

import json
from datetime import datetime
from enum import Enum
from typing import Any, get_args, get_origin, get_type_hints


class _FieldInfo:
    def __init__(self, default: Any = None, default_factory=None, description: str | None = None):
        self.default = default
        self.default_factory = default_factory
        self.description = description


def Field(default: Any = None, *, default_factory=None, description: str | None = None):
    return _FieldInfo(default=default, default_factory=default_factory, description=description)


def model_validator(*, mode: str):
    def decorator(func):
        func._model_validator_mode = mode
        return func

    return decorator


class BaseModel:
    __validators_after__ = []

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        cls.__validators_after__ = []
        for name in dir(cls):
            obj = getattr(cls, name)
            if callable(obj) and getattr(obj, "_model_validator_mode", None) == "after":
                cls.__validators_after__.append(obj)

    def __init__(self, **kwargs):
        annotations = get_type_hints(self.__class__)
        for field in annotations:
            annotation = annotations[field]
            if field in kwargs:
                value = kwargs[field]
            else:
                default = getattr(self.__class__, field, None)
                if isinstance(default, _FieldInfo):
                    if default.default_factory is not None:
                        value = default.default_factory()
                    else:
                        value = default.default
                else:
                    value = default
            setattr(self, field, _coerce_value(annotation, value))

        for validator in self.__class__.__validators_after__:
            validator(self)

    @classmethod
    def model_validate(cls, payload: Any):
        if isinstance(payload, cls):
            return payload
        if isinstance(payload, dict):
            return cls(**payload)
        raise TypeError(f"Unsupported payload type for {cls.__name__}: {type(payload)}")

    def model_dump(self, mode: str | None = None) -> dict:
        annotations = get_type_hints(self.__class__)
        return {field: _normalize(getattr(self, field)) for field in annotations}

    def model_dump_json(self, indent: int | None = None) -> str:
        return json.dumps(self.model_dump(mode="json"), indent=indent)

    @classmethod
    def model_validate_json(cls, payload: str):
        return cls.model_validate(json.loads(payload))


def _normalize(value: Any):
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    return value


def _coerce_value(annotation: Any, value: Any):
    if value is None:
        return None

    origin = get_origin(annotation)
    args = get_args(annotation)

    if origin is list and args:
        return [_coerce_value(args[0], item) for item in value]
    if origin is dict and len(args) == 2:
        return {k: _coerce_value(args[1], v) for k, v in value.items()}
    if origin is not None and args:
        non_none = [arg for arg in args if arg is not type(None)]
        if len(non_none) == 1:
            return _coerce_value(non_none[0], value)

    if isinstance(annotation, type) and issubclass(annotation, BaseModel) and isinstance(value, dict):
        return annotation.model_validate(value)
    if isinstance(annotation, type) and issubclass(annotation, Enum) and not isinstance(value, annotation):
        return annotation(value)
    if annotation is datetime and isinstance(value, str):
        return datetime.fromisoformat(value)
    return value
