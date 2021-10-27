#!/usr/bin/env node

import {PostgresDatabase, typescriptOfSchema} from "./generator";
import pg from "pg"
import * as fs from "fs"
import {relative} from 'path'

const {Client} = pg

let jsonConfigPath = process.argv[3] ?? 'pg2ts.json';

async function start() {
    let rawdata = (await fs.promises.readFile(jsonConfigPath)).toString();
    let config = JSON.parse(rawdata);
    const outDir = config.dest || "gen"
    const outputPath = relative(process.cwd(), outDir)
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath)
    }
    const client = new Client({
        ...config.db
    })
    const db = new PostgresDatabase(client)
    await db.isReady()
    const output = await typescriptOfSchema(db, {...config, mainPrefix: config.mainPrefix || config.db.database})
    console.log("output: ", output)
    const prefix = config.mainPrefix ? config.mainPrefix + '-' : ''
    await fs.promises.writeFile(outputPath + `/${prefix}${config.db.database}-tables.ts`, output, 'utf8')
    console.log(`Written schema to ${outputPath}`)
    await db.close()
    process.exit()
}

start()
