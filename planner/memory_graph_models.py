from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator


class MemoryNodeType(str, Enum):
    API = "api"
    MODULE = "module"
    CONVENTION = "convention"
    PRIOR_FIX = "prior_fix"
    CRITIQUE_OUTCOME = "critique_outcome"
    RELIABILITY_RUN = "reliability_run"
    ROLLBACK_OUTCOME = "rollback_outcome"
    BENCHMARK_RUN = "benchmark_run"


class MemoryEdgeType(str, Enum):
    DEPENDENCY = "dependency"
    EVOLUTION = "evolution"


class MemoryNode(BaseModel):
    id: str
    type: MemoryNodeType
    title: str
    path: Optional[str] = None
    summary: str = ""
    tags: List[str] = Field(default_factory=list)
    evidence: List[str] = Field(default_factory=list)
    embedding: List[float] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class MemoryEdge(BaseModel):
    id: str
    from_node_id: str
    to_node_id: str
    type: MemoryEdgeType = MemoryEdgeType.DEPENDENCY
    weight: float = 1.0
    evidence: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class MemoryGraph(BaseModel):
    nodes: Dict[str, MemoryNode] = Field(default_factory=dict)
    edges: Dict[str, MemoryEdge] = Field(default_factory=dict)
    sqlite_path: str = ".logik/memory/graph.sqlite"
    vector_index: str = "hashed-cosine:v1"
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @model_validator(mode="after")
    def validate_edges(self) -> "MemoryGraph":
        for edge_id, edge in self.edges.items():
            if edge_id != edge.id:
                raise ValueError(f"Edge map key '{edge_id}' must match edge.id '{edge.id}'")
            if edge.from_node_id not in self.nodes:
                raise ValueError(f"Edge '{edge_id}' references unknown from_node_id '{edge.from_node_id}'")
            if edge.to_node_id not in self.nodes:
                raise ValueError(f"Edge '{edge_id}' references unknown to_node_id '{edge.to_node_id}'")
        return self
