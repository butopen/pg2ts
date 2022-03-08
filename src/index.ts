#!/usr/bin/env node

import { PostgresDatabase, typescriptOfSchema } from "./generator";
import pg from "pg";
import * as fs from "fs";
import * as path from "path";

require("dotenv").config();

const { Client } = pg;

let jsonConfigPath = process.argv[3] ?? "pg2ts.json";

async function getDB(config) {
  try {
    const client = new Client({
      ...config.db,
    });
    const db = new PostgresDatabase(client);
    await db.isReady();
    return db;
  } catch (e) {
    const client = new Client({
      ...config.db,
      ssl: {
        rejectUnauthorized: false,
      },
    });
    const db = new PostgresDatabase(client);
    await db.isReady();
    return db;
  }
}

async function start() {
  let config = { dest: "./src/generated/", mainPrefix: "gdb" } as any;
  if (fs.existsSync(jsonConfigPath)) {
    let rawdata = (await fs.promises.readFile(jsonConfigPath)).toString();
    config = JSON.parse(rawdata);
  } else {
    const { DB_HOST, DB_PASSWORD, DB_USRENAME, DB_NAME, DB_PORT } = process.env;
    config.db = {
      host: DB_HOST,
      user: DB_USRENAME,
      password: DB_PASSWORD,
      database: DB_NAME,
      port: DB_PORT || 5432,
    };
  }
  console.log("Using configuration: ", config);
  const outDir = config.dest || "gen";
  const outputPath = path.resolve(process.cwd(), outDir);
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }
  const db = await getDB(config);
  const output = await typescriptOfSchema(db, {
    ...config,
    mainPrefix: config.mainPrefix || config.db.database,
  });
  console.log("output: ", output);
  const prefix = config.mainPrefix ? config.mainPrefix + "-" : "";
  await fs.promises.writeFile(
    outputPath + `/${prefix}${config.db.database}-tables.ts`,
    output,
    "utf8"
  );
  console.log(`Written schema to ${outputPath}`);
  await db.close();
  process.exit();
}

try {
  start();
} catch (e) {
  console.log(e);
}
