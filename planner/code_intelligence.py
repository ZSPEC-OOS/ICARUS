from __future__ import annotations

import ast
from collections import defaultdict, deque
from pathlib import Path
from typing import DefaultDict, Dict, Iterable, List, Set

from pydantic import BaseModel, Field


class SymbolDefinition(BaseModel):
    symbol: str
    module: str
    file_path: str
    line: int
    kind: str


class CodeIntelligenceSnapshot(BaseModel):
    definitions: Dict[str, SymbolDefinition] = Field(default_factory=dict)
    references: Dict[str, List[str]] = Field(default_factory=dict)
    call_hierarchy: Dict[str, List[str]] = Field(default_factory=dict)
    dependency_graph: Dict[str, List[str]] = Field(default_factory=dict)


class _PythonModuleAnalyzer(ast.NodeVisitor):
    def __init__(self, module: str, file_path: str):
        self.module = module
        self.file_path = file_path
        self.definitions: Dict[str, SymbolDefinition] = {}
        self.import_aliases: Dict[str, str] = {}
        self.calls_by_symbol: DefaultDict[str, Set[str]] = defaultdict(set)
        self.refs_by_symbol: DefaultDict[str, Set[str]] = defaultdict(set)
        self.current_symbol = f"{module}.__module__"

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            local = alias.asname or alias.name.split(".")[-1]
            self.import_aliases[local] = alias.name

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module is None:
            return
        for alias in node.names:
            local = alias.asname or alias.name
            self.import_aliases[local] = f"{node.module}.{alias.name}"

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_symbol_def(node.name, node, kind="function")

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_symbol_def(node.name, node, kind="function")

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._visit_symbol_def(node.name, node, kind="class")

    def visit_Call(self, node: ast.Call) -> None:
        called = self._resolve_expr_name(node.func)
        if called:
            self.calls_by_symbol[self.current_symbol].add(called)
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        resolved = self.import_aliases.get(node.id, node.id)
        self.refs_by_symbol[self.current_symbol].add(resolved)

    def _visit_symbol_def(self, name: str, node: ast.AST, kind: str) -> None:
        symbol = f"{self.module}.{name}"
        self.definitions[symbol] = SymbolDefinition(
            symbol=symbol,
            module=self.module,
            file_path=self.file_path,
            line=getattr(node, "lineno", 1),
            kind=kind,
        )
        prev = self.current_symbol
        self.current_symbol = symbol
        self.generic_visit(node)
        self.current_symbol = prev

    def _resolve_expr_name(self, expr: ast.AST) -> str | None:
        if isinstance(expr, ast.Name):
            return self.import_aliases.get(expr.id, expr.id)
        if isinstance(expr, ast.Attribute):
            root = self._resolve_expr_name(expr.value)
            if root:
                return f"{root}.{expr.attr}"
            return expr.attr
        return None


class CodeIntelligence:
    def analyze_workspace(self, workspace_root: str | Path) -> CodeIntelligenceSnapshot:
        root = Path(workspace_root)
        definitions: Dict[str, SymbolDefinition] = {}
        raw_calls: DefaultDict[str, Set[str]] = defaultdict(set)
        raw_refs: DefaultDict[str, Set[str]] = defaultdict(set)

        py_files = sorted(root.rglob("*.py"))
        for py_file in py_files:
            if any(part.startswith(".") for part in py_file.parts):
                continue
            module = py_file.relative_to(root).with_suffix("").as_posix().replace("/", ".")
            source = py_file.read_text(encoding="utf-8")
            try:
                tree = ast.parse(source)
            except SyntaxError:
                continue
            analyzer = _PythonModuleAnalyzer(module=module, file_path=str(py_file.relative_to(root)))
            analyzer.visit(tree)
            definitions.update(analyzer.definitions)
            for symbol, calls in analyzer.calls_by_symbol.items():
                raw_calls[symbol].update(calls)
            for symbol, refs in analyzer.refs_by_symbol.items():
                raw_refs[symbol].update(refs)

        canonical_by_leaf: DefaultDict[str, List[str]] = defaultdict(list)
        for symbol in definitions:
            canonical_by_leaf[symbol.split(".")[-1]].append(symbol)

        resolved_calls = {
            caller: sorted(self._resolve_targets(targets, canonical_by_leaf)) for caller, targets in raw_calls.items()
        }
        resolved_refs = {
            owner: sorted(self._resolve_targets(targets, canonical_by_leaf)) for owner, targets in raw_refs.items()
        }

        dependency_graph: DefaultDict[str, Set[str]] = defaultdict(set)
        for owner, targets in resolved_refs.items():
            for target in targets:
                dependency_graph[owner].add(target)

        return CodeIntelligenceSnapshot(
            definitions=definitions,
            references={k: sorted(v) for k, v in resolved_refs.items()},
            call_hierarchy=resolved_calls,
            dependency_graph={k: sorted(v) for k, v in dependency_graph.items()},
        )

    def simulate_impact(self, snapshot: CodeIntelligenceSnapshot, changed_symbols: Iterable[str]) -> Set[str]:
        reverse_deps: DefaultDict[str, Set[str]] = defaultdict(set)
        for source, targets in snapshot.dependency_graph.items():
            for target in targets:
                reverse_deps[target].add(source)

        impacted: Set[str] = set(changed_symbols)
        queue = deque(changed_symbols)
        while queue:
            current = queue.popleft()
            for dependent in reverse_deps.get(current, set()):
                if dependent not in impacted:
                    impacted.add(dependent)
                    queue.append(dependent)
        return impacted

    def _resolve_targets(self, targets: Iterable[str], canonical_by_leaf: Dict[str, List[str]]) -> Set[str]:
        resolved: Set[str] = set()
        for target in targets:
            leaf = target.split(".")[-1]
            known = canonical_by_leaf.get(leaf)
            if known and len(known) == 1:
                resolved.add(known[0])
        return resolved
