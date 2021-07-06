import {
  Duration,
  LocalDate,
  LocalDateTime,
  LocalTime,
} from "../../datatypes/datetime";
import {expr_PathLeaf, expr_PathNode} from "./paths";
import {expr_Literal} from "./literals";
import {expr_Set} from "./set";
import {ExpressionKind, MaterialType, TypeKind} from "../typesystem";

export type SomeExpression =
  | expr_PathNode
  | expr_PathLeaf
  | expr_Literal
  | expr_Set;

export function toEdgeQL(this: any) {
  const expr: SomeExpression = this;
  if (
    expr.__kind__ === ExpressionKind.PathNode ||
    expr.__kind__ === ExpressionKind.PathLeaf
  ) {
    if (!expr.__parent__) {
      return expr.__element__.__name__;
    } else {
      return `${expr.__parent__.type.toEdgeQL()}.${
        expr.__parent__.linkName
      }`.trim();
    }
  } else if (expr.__kind__ === ExpressionKind.Literal) {
    return literalToEdgeQL(expr.__element__, expr.__value__);
  } else if (expr.__kind__ === ExpressionKind.Set) {
    const exprs = expr.__exprs__;
    if (exprs.every((ex) => ex.__element__.__kind__ === TypeKind.object)) {
      return `{ ${exprs.map((ex) => ex.toEdgeQL()).join(", ")} }`;
    } else if (
      exprs.every((ex) => ex.__element__.__kind__ !== TypeKind.object)
    ) {
      return `{ ${exprs.map((ex) => ex.toEdgeQL()).join(", ")} }`;
    } else {
      throw new Error(
        `Invalid arguments to set constructor: ${exprs
          .map((ex) => expr.__element__.__name__)
          .join(", ")}`
      );
    }
  } else {
    throw new Error(`Unrecognized expression kind.`);
  }
}

export function literalToEdgeQL(type: MaterialType, val: any): string {
  let stringRep;
  if (typeof val === "string") {
    stringRep = `'${val}'`;
  } else if (typeof val === "number") {
    stringRep = `${val.toString()}`;
  } else if (typeof val === "boolean") {
    stringRep = `${val.toString()}`;
  } else if (typeof val === "bigint") {
    stringRep = `${val.toString()}n`;
  } else if (Array.isArray(val)) {
    if (type.__kind__ === TypeKind.array) {
      stringRep = `[${val
        .map((el) => literalToEdgeQL(type.__element__ as any, el))
        .join(", ")}]`;
    } else if (type.__kind__ === TypeKind.unnamedtuple) {
      stringRep = `( ${val
        .map((el, j) => literalToEdgeQL(type.__items__[j] as any, el))
        .join(", ")} )`;
    } else {
      throw new Error(`Invalid value for type ${type.__name__}`);
    }
  } else if (val instanceof Date) {
    stringRep = `'${val.toISOString()}'`;
  } else if (val instanceof LocalDate) {
    stringRep = `'${val.toString()}'`;
  } else if (val instanceof LocalDateTime) {
    stringRep = `'${val.toString()}'`;
  } else if (val instanceof LocalTime) {
    stringRep = `'${val.toString()}'`;
  } else if (val instanceof Duration) {
    stringRep = `'${val.toString()}'`;
  } else if (typeof val === "object") {
    if (type.__kind__ === TypeKind.namedtuple) {
      stringRep = `( ${Object.entries(val).map(
        ([key, value]) =>
          `${key} := ${literalToEdgeQL(type.__shape__[key], value)}`
      )} )`;
    } else {
      throw new Error(`Invalid value for type ${type.__name__}`);
    }
  } else {
    throw new Error(`Invalid value for type ${type.__name__}`);
  }
  return `<${type.__name__}>${stringRep}`;
}
