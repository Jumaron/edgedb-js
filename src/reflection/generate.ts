import {CodeBuilder, DirBuilder} from "./builders";
import {connect} from "../index.node";
import {Connection} from "../ifaces";
import {StrictMap} from "./strictMap";
import {ConnectConfig} from "../con_utils";
import {getCasts} from "./casts";

type UUID = string;

type IntrospectedPointer = {
  cardinality: "One" | "Many";
  kind: "link" | "property";
  required: boolean;
  name: string;
  expr: string | null;

  target_id: UUID;

  pointers: ReadonlyArray<IntrospectedPointer> | null;
};

type IntrospectedTypeKind = "object" | "scalar" | "array" | "tuple";

type IntrospectedBaseType<T extends IntrospectedTypeKind> = {
  kind: T;
  id: UUID;
  name: string;
};

type IntrospectedScalarType = IntrospectedBaseType<"scalar"> & {
  is_abstract: boolean;
  bases: ReadonlyArray<{id: UUID}>;
  ancestors: ReadonlyArray<{id: UUID}>;
  enum_values: ReadonlyArray<string>;
  material_id: UUID | null;
};

type IntrospectedObjectType = IntrospectedBaseType<"object"> & {
  is_abstract: boolean;
  bases: ReadonlyArray<{id: UUID}>;
  ancestors: ReadonlyArray<{id: UUID}>;
  union_of: ReadonlyArray<{id: UUID}>;
  intersection_of: ReadonlyArray<{id: UUID}>;
  pointers: ReadonlyArray<IntrospectedPointer>;
};

type IntrospectedArrayType = IntrospectedBaseType<"array"> & {
  array_element_id: UUID;
};

type IntrospectedTupleType = IntrospectedBaseType<"tuple"> & {
  tuple_elements: ReadonlyArray<{
    name: string;
    target_id: UUID;
  }>;
};

type IntrospectedPrimitiveType =
  | IntrospectedScalarType
  | IntrospectedArrayType
  | IntrospectedTupleType;

type IntrospectedType = IntrospectedPrimitiveType | IntrospectedObjectType;

type IntrospectedTypes = StrictMap<UUID, IntrospectedType>;

export async function fetchTypes(con: Connection): Promise<IntrospectedTypes> {
  const QUERY = `
    WITH
      MODULE schema,

      material_scalars := (
        SELECT ScalarType
        FILTER
          (.name LIKE 'std::%' OR .name LIKE 'cal::%')
          AND NOT .is_abstract
      )

    SELECT Type {
      id,
      name,
      is_abstract,

      kind := 'object' IF Type IS ObjectType ELSE
              'scalar' IF Type IS ScalarType ELSE
              'array' IF Type IS Array ELSE
              'tuple' IF Type IS Tuple ELSE
              'unknown',

      [IS ScalarType].enum_values,

      single material_id := (
        SELECT x := Type[IS ScalarType].ancestors
        FILTER x IN material_scalars
        LIMIT 1
      ).id,

      [IS InheritingObject].bases: {
        id
      } ORDER BY @index ASC,

      [IS InheritingObject].ancestors: {
        id
      } ORDER BY @index ASC,

      [IS ObjectType].union_of,
      [IS ObjectType].intersection_of,
      [IS ObjectType].pointers: {
        cardinality,
        required,
        name,
        expr,

        target_id := .target.id,

        kind := 'link' IF .__type__.name = 'schema::Link' ELSE 'property',

        [IS Link].pointers: {
          cardinality,
          required,
          name,
          expr,
          target_id := .target.id,
          kind := 'link' IF .__type__.name = 'schema::Link' ELSE 'property',
        } FILTER @is_owned,
      } FILTER @is_owned,

      array_element_id := [IS Array].element_type.id,

      tuple_elements := (SELECT [IS Tuple].element_types {
        target_id := .type.id,
        name
      } ORDER BY @index ASC),
    }
    ORDER BY .name;
  `;

  const types: IntrospectedType[] = await con.query(QUERY);
  console.log(JSON.stringify(JSON.parse(await con.queryJSON(QUERY)), null, 2));
  // Now sort `types` topologically:

  const graph = new StrictMap<UUID, IntrospectedType>();
  const adj = new StrictMap<UUID, Set<UUID>>();

  for (const type of types) {
    graph.set(type.id, type);
  }

  for (const type of types) {
    if (type.kind !== "object" && type.kind !== "scalar") {
      continue;
    }

    for (const {id: base} of type.bases) {
      if (!graph.has(base))
        throw new Error(`reference to an unknown object type: ${base}`);

      if (!adj.has(type.id)) {
        adj.set(type.id, new Set());
      }

      adj.get(type.id).add(base);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<UUID>();
  const sorted = new StrictMap<UUID, IntrospectedType>();

  const visit = (type: IntrospectedType) => {
    if (visiting.has(type.name)) {
      const last = Array.from(visiting).slice(1, 2);
      throw new Error(`dependency cycle between ${type.name} and ${last}`);
    }
    if (!visited.has(type.id)) {
      visiting.add(type.name);
      if (adj.has(type.id)) {
        for (const adjId of adj.get(type.id).values()) {
          visit(graph.get(adjId));
        }
      }
      sorted.set(type.id, type);
      visited.add(type.id);
      visiting.delete(type.name);
    }
  };

  for (const type of types) {
    visit(type);
  }

  return sorted;
}

function getModule(name: string): string {
  const parts = name.split("::");
  if (!parts || parts.length !== 2) {
    throw new Error(`getModule: invalid name ${name}`);
  }
  return parts[0];
}

function getName(name: string): string {
  const parts = name.split("::");
  if (!parts || parts.length !== 2) {
    throw new Error(`getName: invalid name ${name}`);
  }
  return parts[1];
}

function snToIdent(name: string): string {
  if (name.includes("::")) {
    throw new Error(`snToIdent: invalid name ${name}`);
  }
  return name.replace(/([^a-zA-Z0-9_]+)/g, "_");
}

function fqnToIdent(name: string): string {
  if (!name.includes("::")) {
    throw new Error(`fqnToIdent: invalid name ${name}`);
  }
  return name.replace(/([^a-zA-Z0-9_]+)/g, "_");
}

function quote(val: string): string {
  return JSON.stringify(val.toString());
}

function toCardinality(p: IntrospectedPointer): string {
  if (p.cardinality === "One") {
    if (p.required) {
      return "One";
    } else {
      return "AtMostOne";
    }
  } else {
    if (p.required) {
      return "AtLeastOne";
    } else {
      return "Many";
    }
  }
}

function toPrimitiveJsType(
  s: IntrospectedScalarType,
  code: CodeBuilder
): string {
  function addEdgedbImport(): void {
    code.addImport(`import * as edgedb from "edgedb";`);
  }

  switch (s.name) {
    case "std::int16":
    case "std::int32":
    case "std::int64":
    case "std::float32":
    case "std::float64":
      return "number";

    case "std::str":
    case "std::uuid":
    case "std::json":
      return "string";

    case "std::bool":
      return "boolean";

    case "std::bigint":
      return "BigInt";

    case "std::datetime":
      return "Date";

    case "std::duration":
      addEdgedbImport();
      return "edgedb.Duration";
    case "cal::local_datetime":
      addEdgedbImport();
      return "edgedb.LocalDateTime";
    case "cal::local_date":
      addEdgedbImport();
      return "edgedb.LocalDate";
    case "cal::local_time":
      addEdgedbImport();
      return "edgedb.LocalTime";

    case "std::decimal":
    case "std::bytes":
    // TODO

    default:
      return "unknown";
  }
}

function assertNever(arg: never): never {
  throw new Error(`${arg} is supposed to be of "never" type`);
}

function toJsScalarType(
  type: IntrospectedPrimitiveType,
  types: IntrospectedTypes,
  currentModule: string,
  code: CodeBuilder,
  level: number = 0
): string {
  switch (type.kind) {
    case "scalar": {
      if (type.enum_values && type.enum_values.length) {
        const mod = getModule(type.name);
        const name = getName(type.name);
        code.addImport(
          `import type * as ${mod}Enums from "../modules/${mod}";`
        );
        return `${mod}Enums.${name}`;
      }

      if (type.material_id) {
        return toJsScalarType(
          types.get(type.material_id) as IntrospectedScalarType,
          types,
          currentModule,
          code,
          level + 1
        );
      }

      return toPrimitiveJsType(type, code);
    }

    case "array": {
      const tn = toJsScalarType(
        types.get(type.array_element_id) as IntrospectedPrimitiveType,
        types,
        currentModule,
        code,
        level + 1
      );
      return `${tn}[]`;
    }

    case "tuple": {
      if (!type.tuple_elements.length) {
        return "[]";
      }

      if (
        type.tuple_elements[0].name &&
        Number.isNaN(parseInt(type.tuple_elements[0].name, 10))
      ) {
        // a named tuple
        const res = [];
        for (const {name, target_id} of type.tuple_elements) {
          const tn = toJsScalarType(
            types.get(target_id) as IntrospectedPrimitiveType,
            types,
            currentModule,
            code,
            level + 1
          );
          res.push(`${name}: ${tn}`);
        }
        return `{${res.join(",")}}`;
      } else {
        // an ordinary tuple
        const res = [];
        for (const {target_id} of type.tuple_elements) {
          const tn = toJsScalarType(
            types.get(target_id) as IntrospectedPrimitiveType,
            types,
            currentModule,
            code,
            level + 1
          );
          res.push(tn);
        }
        return `[${res.join(",")}]`;
      }
    }

    default:
      assertNever(type);
  }
}

function toJsObjectType(
  type: IntrospectedObjectType,
  types: IntrospectedTypes,
  currentMod: string,
  code: CodeBuilder,
  level: number = 0
): string {
  if (type.intersection_of && type.intersection_of.length) {
    const res: string[] = [];
    for (const {id: subId} of type.intersection_of) {
      const sub = types.get(subId) as IntrospectedObjectType;
      res.push(toJsObjectType(sub, types, currentMod, code, level + 1));
    }
    const ret = res.join(" & ");
    return level > 0 ? `(${ret})` : ret;
  }

  if (type.union_of && type.union_of.length) {
    const res: string[] = [];
    for (const {id: subId} of type.union_of) {
      const sub = types.get(subId) as IntrospectedObjectType;
      res.push(toJsObjectType(sub, types, currentMod, code, level + 1));
    }
    const ret = res.join(" | ");
    return level > 0 ? `(${ret})` : ret;
  }

  const mod = getModule(type.name);
  if (mod !== currentMod) {
    code.addImport(`import type * as ${mod}Types from "./${mod}";`);
    return `${mod}Types.${getName(type.name)}`;
  } else {
    return getName(type.name);
  }
}

export async function generateCasts(cxn?: ConnectConfig): Promise<void> {
  const con = await connect(cxn);
  const casts = await getCasts(con);
  console.log(casts);
}

export async function generateQB(
  to: string,
  cxn?: ConnectConfig
): Promise<void> {
  const con = await connect(cxn);

  const dir = new DirBuilder();

  try {
    const types = await fetchTypes(con);
    const modsIndex = new Set<string>();

    for (const type of types.values()) {
      if (type.kind !== "scalar" && type.kind !== "object") {
        continue;
      }

      const mod = getModule(type.name);
      modsIndex.add(mod);

      if (
        type.kind !== "scalar" ||
        !type.enum_values ||
        !type.enum_values.length
      ) {
        continue;
      }

      const b = dir.getPath(`modules/${mod}.ts`);

      b.writeln(`export enum ${getName(type.name)} {`);
      b.indented(() => {
        for (const val of type.enum_values) {
          b.writeln(`${snToIdent(val)} = ${quote(val)},`);
        }
      });
      b.writeln(`}`);
      b.nl();
    }

    for (const type of types.values()) {
      if (type.kind !== "object") {
        continue;
      }
      if (
        (type.union_of && type.union_of.length) ||
        (type.intersection_of && type.intersection_of.length)
      ) {
        continue;
      }

      const mod = getModule(type.name);
      const body = dir.getPath(`__types__/${mod}.ts`);

      body.addImport(`import {reflection as $} from "edgedb";`);

      const bases = [];
      for (const {id: baseId} of type.bases) {
        const baseType = types.get(baseId);
        const baseMod = getModule(baseType.name);
        if (baseMod !== mod) {
          body.addImport(
            `import type * as ${baseMod}Types from "./${baseMod}";`
          );
          bases.push(`${baseMod}Types.${getName(baseType.name)}`);
        } else {
          bases.push(getName(baseType.name));
        }
      }
      if (bases.length) {
        body.writeln(
          `export interface ${snToIdent(
            getName(type.name)
          )} extends ${bases.join(", ")} {`
        );
      } else {
        body.writeln(`export interface ${snToIdent(getName(type.name))} {`);
      }

      body.indented(() => {
        for (const ptr of type.pointers) {
          const card = `$.Cardinality.${toCardinality(ptr)}`;

          if (ptr.kind === "link") {
            const trgType = types.get(ptr.target_id) as IntrospectedObjectType;

            const tsType = toJsObjectType(trgType, types, mod, body);

            body.writeln(`${ptr.name}: $.LinkDesc<${tsType}, ${card}>;`);
          } else {
            const tgtType = types.get(
              ptr.target_id
            ) as IntrospectedPrimitiveType;

            const tsType = toJsScalarType(tgtType, types, mod, body);

            body.writeln(`${ptr.name}: $.PropertyDesc<${tsType}, ${card}>;`);
          }
        }
      });
      body.writeln(`}`);
      body.nl();
    }

    const bm = dir.getPath("__spec__.ts");
    bm.addImport(`import {reflection as $} from "edgedb";`);
    bm.writeln(`export const spec: $.TypesSpec = new $.StrictMap();`);
    bm.nl();

    for (const type of types.values()) {
      if (type.kind !== "object") {
        continue;
      }

      bm.writeln(`spec.set("${type.name}", {`);
      bm.indented(() => {
        bm.writeln(`name: ${JSON.stringify(type.name)},`);

        const bases: string[] = [];
        for (const {id: baseId} of type.bases) {
          const base = types.get(baseId);
          bases.push(base.name);
        }
        bm.writeln(`bases: ${JSON.stringify(bases)},`);

        const ancestors: string[] = [];
        for (const {id: baseId} of type.ancestors) {
          const base = types.get(baseId);
          ancestors.push(base.name);
        }
        bm.writeln(`ancestors: ${JSON.stringify(ancestors)},`);

        bm.writeln(`properties: [`);
        bm.indented(() => {
          for (const ptr of type.pointers) {
            if (ptr.kind !== "property") {
              continue;
            }

            bm.writeln(`{`);
            bm.indented(() => {
              bm.writeln(`name: ${JSON.stringify(ptr.name)},`);
              bm.writeln(`cardinality: $.Cardinality.${toCardinality(ptr)},`);
            });
            bm.writeln(`},`);
          }
        });
        bm.writeln(`],`);

        bm.writeln(`links: [`);
        bm.indented(() => {
          for (const ptr of type.pointers) {
            if (ptr.kind !== "link") {
              continue;
            }

            bm.writeln(`{`);
            bm.indented(() => {
              bm.writeln(`name: ${JSON.stringify(ptr.name)},`);
              bm.writeln(`cardinality: $.Cardinality.${toCardinality(ptr)},`);
              bm.writeln(
                `target: ${JSON.stringify(types.get(ptr.target_id).name)},`
              );
              bm.writeln(`properties: [`);
              if (ptr.pointers && ptr.pointers.length > 2) {
                for (const prop of ptr.pointers) {
                  if (prop.kind !== "property") {
                    // We only support "link properties" in EdgeDB, currently.
                    continue;
                  }
                  if (prop.name === "source" || prop.name === "target") {
                    // No use for them reflected, at the moment.
                    continue;
                  }
                  bm.writeln(`{`);
                  bm.indented(() => {
                    bm.writeln(`name: ${JSON.stringify(prop.name)},`);
                    bm.writeln(
                      `cardinality: $.Cardinality.${toCardinality(prop)},`
                    );
                  });
                  bm.writeln(`},`);
                }
              }
              bm.writeln(`],`);
            });
            bm.writeln(`},`);
          }
        });
        bm.writeln(`],`);
      });
      bm.writeln(`});`);
      bm.nl();
    }

    for (const type of types.values()) {
      if (type.kind !== "object") {
        continue;
      }
      if (
        (type.union_of && type.union_of.length) ||
        (type.intersection_of && type.intersection_of.length)
      ) {
        continue;
      }

      const mod = getModule(type.name);
      const ident = snToIdent(getName(type.name));
      const body = dir.getPath(`modules/${mod}.ts`);
      body.addImport(`import {reflection as $} from "edgedb";`);
      body.addImport(`import {spec as __spec__} from "../__spec__";`);
      body.addImport(`import type * as __types__ from "../__types__/${mod}";`);

      body.writeln(
        `export const ${ident} = $.objectType<__types__.${ident}>(`
      );
      body.indented(() => {
        body.writeln(`__spec__,`);
        body.writeln(`${JSON.stringify(type.name)},`);
      });
      body.writeln(`);`);
      body.nl();
    }

    const index = dir.getPath("index.ts");
    for (const mod of Array.from(modsIndex).sort()) {
      if (dir.getPath(`modules/${mod}.ts`).isEmpty()) {
        continue;
      }
      index.addImport(`export * as ${mod} from "./modules/${mod}";`);
    }
  } finally {
    await con.close();
  }

  console.log(`writing to disk.`);
  dir.write(to);
}
