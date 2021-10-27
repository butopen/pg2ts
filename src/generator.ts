/**
 * Thanks to the beautiful work by https://github.com/vramework/schemats : we used it's source code and 
 * edited it to generate string constants rather than types
 */


import {Database, EnumTypes, TableDefinition} from './schema-interfaces'
import {camelCase} from "./camelcase.util";
import {Client} from 'pg'

const generateHeader = (): string => {
    return `
/**
 * AUTO-GENERATED FILE @ ${new Date().toUTCString()}
 */`
}

const reservedJSNames = new Set(['string', 'number', 'package'])
const normalizeName = (name: string): string => reservedJSNames.has('name') ? `${name}_` : name

export function generateEnum(enumObject: EnumTypes): string[] {
    const enumStrings: string[] = []
    for (let enumNameRaw in enumObject) {
        const enumName = camelCase(enumNameRaw)
        enumStrings.push(`export type ${enumName} = ${enumObject[enumNameRaw].map((v: string) => `'${v}'`).join(' | ')}`)
    }
    return enumStrings
}

export function generateTableInterface(tableNameRaw: string, tableDefinition: TableDefinition) {
    const tableName = camelCase(tableNameRaw, {pascalCase: true})
    let members = ''
    const entries = Object.entries(tableDefinition)
    for (const [name, {tsType, nullable, isArray}] of entries) {
        const columnName = camelCase(name)
        members += `\n\t${normalizeName(columnName)}${nullable ? '?' : ''}: ${tsType}${isArray ? '[]' : ''}${nullable ? ' | null' : ''}`
    }
    return `export interface ${normalizeName(tableName)} { ${members} \n}`
}

export const typescriptOfTable = async (db: Database, schema: string, table: string, types: Set<string>) => {
    const tableTypes = await db.getTableTypes(schema, table, types)
    return generateTableInterface(table, tableTypes)
}

export const typescriptTablesConst = async (db: Database, tables: string[], tableSchema: string, mainPrefix = ''): Promise<string> => {
    const fields: string[] = []
    for (let t of tables) {
        const tableDefinition = await db.getTableDefinition(tableSchema, t);
        const columns: string[] = [];
        for (const col in tableDefinition)
            columns.push(col)
        let f = `${t}: {tableName: "${t}", ${columns.map(c => `${c}: "${t}.${c}"`).join(",")}}`;
        fields.push(f);
    }
    return `export const ${camelCase(mainPrefix, {pascalCase: true})}TablesData = {
        tableNames: {${tables.map(t => `${t}: "${t}"`)}}, 
        ${fields.join(",\n	")}
    }`;
}

function tablesListClassName(mainPrefix = ''){
    return camelCase(mainPrefix+"Tables", {pascalCase: true})
}

export const typescriptLookupForTables = (tables: string[], mainPrefix = ''): string => {
    const types = tables.map(t => `${t}: ${camelCase(t, {pascalCase: true})}`)
    return `export interface ${tablesListClassName(mainPrefix)} {
    ${types.join(',\n\t')}
}`
}

export const typescriptOfSchema = async (db: Database, options = {schema: '', mainPrefix: ''}): Promise<string> => {
    const schema = options.schema || await db.getDefaultSchema()
    const tables = await db.getSchemaTables(schema)
    const enums = await db.getEnums(schema)
    const enumTypes = generateEnum(enums)
    const jsonTypesToImport = new Set<string>()
    const interfaces = await Promise.all(tables.map(table => typescriptOfTable(db, schema, table, jsonTypesToImport)))
    const output = [enumTypes.join('\n\n'), interfaces.join('\n\n')]

    output.unshift(generateHeader())

    output.push(typescriptLookupForTables(tables, options.mainPrefix))
    const consts = await typescriptTablesConst(db, tables, schema, options.mainPrefix)
    output.push(consts)

    return output.join('\n\n')
}


export const mapPostgresTableDefinitionToType = (tableDefinition: TableDefinition, enumTypes: Set<string>, customTypes: Set<string>, columnDescriptions: Record<string, string>): TableDefinition => {
    return Object.entries(tableDefinition).reduce((result, [columnName, column]) => {
        switch (column.udtName) {
            case 'bpchar':
            case 'char':
            case 'varchar':
            case 'text':
            case 'citext':
            case 'uuid':
            case 'bytea':
            case 'inet':
            case 'time':
            case 'timetz':
            case 'interval':
            case 'tsvector':
            case 'name':
                column.tsType = 'string'
                break
            case 'int2':
            case 'int4':
            case 'int8':
            case 'float4':
            case 'float8':
            case 'numeric':
            case 'money':
            case 'oid':
                column.tsType = 'number'
                break
            case 'bool':
                column.tsType = 'boolean'
                break
            case 'json':
            case 'jsonb':
                column.tsType = 'unknown'
                if (columnDescriptions[columnName]) {
                    const type = /@type \{([^}]+)\}/.exec(columnDescriptions[columnName])
                    if (type) {
                        column.tsType = type[1].trim()
                        customTypes.add(column.tsType)
                    }
                }
                break
            case 'date':
            case 'timestamp':
            case 'timestamptz':
                column.tsType = 'Date'
                break
            case 'point':
                column.tsType = '{ x: number, y: number }'
                break
            default:
                if (enumTypes.has(column.udtName)) {
                    column.tsType = camelCase(column.udtName)
                    break
                } else {
                    const warning = `Type [${column.udtName} has been mapped to [any] because no specific type has been found.`
                    console.warn(warning)
                    column.tsType = 'any'
                    break
                }
        }
        result[columnName] = column
        return result
    }, {} as TableDefinition)
}

export class PostgresDatabase implements Database {
    private db: Client
    public version: string = ''

    constructor(client: Client) {
        this.db = client
    }

    public async isReady() {
        await this.db.connect()
        const result = await this.db.query<{ version: string }>(`SELECT version()`)
        this.version = result.rows[0].version
    }

    public async close() {
        await this.db.end()
    }

    public getDefaultSchema(): string {
        return 'public'
    }

    public async getEnums(schema: string): Promise<EnumTypes> {
        const results = await this.db.query<{ name: string, value: string }>(`
            SELECT n.nspname as schema, t.typname as name, e.enumlabel as value
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = $1
        `, [schema])
        return results.rows.reduce((result, {name, value}) => {
            let values = result[name] || []
            values.push(value)
            result[name] = values
            return result
        }, {} as EnumTypes)
    }

    public async getTableDefinition(tableSchema: string, tableName: string) {
        const result = await this.db.query<{ column_name: string, udt_name: string, is_nullable: string, has_default: boolean }>(`
            SELECT column_name, udt_name, is_nullable, column_default IS NOT NULL as has_default
            FROM information_schema.columns
            WHERE table_name = $1 and table_schema = $2
        `, [tableName, tableSchema])
        if (result.rows.length === 0) {
            console.error(`Missing table: ${tableSchema}.${tableName}`)
        }
        // https://www.developerfiles.com/adding-and-retrieving-comments-on-postgresql-tables/
        return result.rows.reduce((result, {column_name, udt_name, is_nullable, has_default}) => {
            result[column_name] = {
                udtName: udt_name.replace(/^_/, ''),
                nullable: is_nullable === 'YES',
                isArray: udt_name.startsWith('_'),
                hasDefault: has_default,
            }
            return result
        }, {} as TableDefinition)
    }

    public async getTableTypes(tableSchema: string, tableName: string, customTypes: Set<string>) {
        const enumTypes = await this.getEnums(tableSchema)
        const columnComments = await this.getColumnComments(tableSchema, tableName)
        return mapPostgresTableDefinitionToType(
            await this.getTableDefinition(tableSchema, tableName),
            new Set(Object.keys(enumTypes)),
            customTypes,
            columnComments
        )
    }

    public async getSchemaTables(schemaName: string): Promise<string[]> {
        const result = await this.db.query(`
            SELECT table_name
            FROM information_schema.columns
            WHERE table_schema = $1
            GROUP BY table_name
        `, [schemaName])
        if (result.rows.length === 0) {
            console.error(`Missing schema: ${schemaName}`)
        }
        return result.rows.map(({table_name}) => table_name)
    }

    /**
     public async getPrimaryKeys(schemaName: string) {
        interface PrimaryKeyDefinition {
            table_name: string;
            constraint_name: string;
            ordinal_position: number;
            key_column: string;
        }
        // https://dataedo.com/kb/query/postgresql/list-all-primary-keys-and-their-columns
        const keysResult: PrimaryKeyDefinition[] = await this.db.query(
            `
                SELECT
                    kcu.table_name,
                    tco.constraint_name,
                    kcu.ordinal_position as position,
                    kcu.column_name as key_column
                FROM information_schema.table_constraints tco
                JOIN information_schema.key_column_usage kcu
                    on kcu.constraint_name = tco.constraint_name
                    and kcu.constraint_schema = tco.constraint_schema
                    and kcu.constraint_name = tco.constraint_name
                WHERE tco.constraint_type = 'PRIMARY KEY'
                  AND kcu.table_schema = $1
                ORDER BY kcu.table_name,
                         position;
            `,
            [schemaName],
        );
        return []
    }
     **/

    public async getColumnComments(schemaName: string, tableName: string) {
        // See https://stackoverflow.com/a/4946306/388951
        const commentsResult = await this.db.query<{
            table_name: string;
            column_name: string;
            description: string;
        }>(
            `
                SELECT
                    c.table_name,
                    c.column_name,
                    pgd.description
                FROM pg_catalog.pg_statio_all_tables AS st
                INNER JOIN pg_catalog.pg_description pgd ON (pgd.objoid=st.relid)
                INNER JOIN information_schema.columns c ON (
                    pgd.objsubid=c.ordinal_position AND
                    c.table_schema=st.schemaname AND
                    c.table_name=st.relname
                )
                WHERE c.table_schema = $1 and c.table_name = $2
            `,
            [schemaName, tableName],
        );
        return commentsResult.rows.reduce((result, {column_name, description}) => {
            result[column_name] = description
            return result
        }, {} as Record<string, string>)
    }

    /**
     public async getTableComments(schemaName: string) {
        interface TableComment {
            table_name: string;
            description: string;
        }
        const comments: TableComment[] = await this.db.query(
            `
                SELECT
                    t.table_name,
                    pgd.description
                FROM pg_catalog.pg_statio_all_tables AS st
                INNER JOIN pg_catalog.pg_description pgd ON (pgd.objoid=st.relid)
                INNER JOIN information_schema.tables t ON (
                    t.table_schema=st.schemaname AND
                    t.table_name=st.relname
                )
                WHERE pgd.objsubid = 0
                  AND t.table_schema = $1;
            `,
            [schemaName],
        );
        return _.fromPairs(comments.map((c) => [c.table_name, c.description]));
    }
     async getForeignKeys(schemaName: string) {
        interface ForeignKey {
            table_name: string;
            column_name: string;
            foreign_table_name: string;
            foreign_column_name: string;
            conname: string;
        }
        // See https://stackoverflow.com/a/10950402/388951
        const fkeys: ForeignKey[] = await this.db.query(
            `
            SELECT
                cl2.relname AS table_name,
                att2.attname AS column_name,
                cl.relname AS foreign_table_name,
                att.attname AS foreign_column_name,
                conname
            FROM
                (SELECT
                    unnest(con1.conkey) AS "parent",
                    unnest(con1.confkey) AS "child",
                    con1.confrelid,
                    con1.conrelid,
                    con1.conname
                FROM pg_class cl
                JOIN pg_namespace ns ON cl.relnamespace = ns.oid
                JOIN pg_constraint con1 ON con1.conrelid = cl.oid
                WHERE ns.nspname = $1 AND con1.contype = 'f'
                ) con
            JOIN pg_attribute att ON att.attrelid = con.confrelid and att.attnum = con.child
            JOIN pg_class cl ON cl.oid = con.confrelid
            JOIN pg_class cl2 ON cl2.oid = con.conrelid
            JOIN pg_attribute att2 ON att2.attrelid = con.conrelid AND att2.attnum = con.parent
            `,
            [schemaName],
        );
        // Multi-column foreign keys are harder to model.
        // To get consistent outputs, just ignore them for now.
        const countKey = (fk: ForeignKey) => `${fk.table_name},${fk.conname}`;
        const colCounts = _.countBy(fkeys, countKey);
        return _(fkeys)
            .filter((c) => colCounts[countKey(c)] < 2)
            .groupBy((c) => c.table_name)
            .mapValues((tks) =>
                _.fromPairs(
                    tks.map((ck) => [
                        ck.column_name,
                        { table: ck.foreign_table_name, column: ck.foreign_column_name },
                    ]),
                ),
            )
            .value();
    }
     async getMeta(schemaName: string): Promise<Metadata> {
        if (this.metadata && schemaName === this.metadata.schema) {
            return this.metadata;
        }
        const [
            enumTypes,
            tableToKeys,
            foreignKeys,
            columnComments,
            tableComments,
        ] = await Promise.all([
            this.getEnumTypes(),
            this.getPrimaryKeys(schemaName),
            this.getForeignKeys(schemaName),
            this.getColumnComments(schemaName),
            this.getTableComments(schemaName),
        ]);
        const metadata: Metadata = {
            schema: schemaName,
            enumTypes,
            tableToKeys,
            foreignKeys,
            columnComments,
            tableComments,
        };
        this.metadata = metadata;
        return metadata;
    }
     */
}

