import { DatabaseInteractions, type DataEntry, type SaveEntry } from "./Classes/DatabaseInteractions";
import { createReadStream, existsSync, readdirSync, } from "node:fs";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { HttpHandler } from "./Classes/HttpHandler";
import { basename, extname, resolve } from "node:path";
import { rename } from "node:fs/promises";

// i3ym
const unslash = (str: string) => str.replaceAll("\\\\", "\\")

// could've done generic but I'm too lazy
const convertToSQL = async (filepath: string, callback: (line: string[][]) => void) => {
    if (extname(filepath) !== ".txt") return;
    console.log("filepath:", filepath);

    const filename = basename(filepath);
    const fileStream = createReadStream(filepath);
    const lines = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    // Hey, look! Batch operations!
    const BATCH_SIZE = 5_000;
    let batch: string[][] = [];
    for await (const line of lines) {
        batch.push(unslash(line).split("\t"));
        if (batch.length >= BATCH_SIZE) {
            callback(batch);
            batch = [];
            console.log(`Processed another ${BATCH_SIZE} of ${filename}..`);
        }
    }

    if (batch.length) {
        callback(batch);
        console.log(`Processed last ${batch.length} of ${filename}.`);
    }

    await rename(filepath, filepath + ".processed");
}

// Make a new database or find existing one
const DB_PATH = "./db_files/database.sqlite";
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA synchronous = OFF;");

DatabaseInteractions.initPlayerTable(db);
DatabaseInteractions.initSavesTable(db);

const promises: Promise<void>[] = [];
console.log("Uploading data from .txt files...")

const TEXT_PLAYERS_FOLDER = "./db_files/players";
if (existsSync(TEXT_PLAYERS_FOLDER)) {
    for (const file of readdirSync(TEXT_PLAYERS_FOLDER)) {
        const start = Date.now();
        const name = `saves/${file}`;
        console.log(`Loading ${name}...`);
        const p = convertToSQL(
            resolve(TEXT_PLAYERS_FOLDER, file),
            (batch) => DatabaseInteractions.insertPlayers(db, batch.map(v => {
                const [playerID, data] = v;
                return {
                    playerID: playerID!,
                    data: data!
                } as DataEntry;
            }))
        );
        promises.push(p);
        console.log(`Finished loading ${name} in ${(Date.now() - start) / 1000}s.`);
    }
}

const TEXT_SAVES_FOLDER = "./db_files/saves";
if (existsSync(TEXT_SAVES_FOLDER)) {
    for (const file of readdirSync(TEXT_SAVES_FOLDER)) {
        const start = Date.now();
        const name = `players/${file}`;
        console.log(`Loading ${name}...`);
        const p = convertToSQL(
            resolve(TEXT_SAVES_FOLDER, file),
            (batch) => DatabaseInteractions.insertSave(db,
                batch.map(v => {
                    const [increment, index, playerID, data] = v;
                    return {
                        playerID: playerID!,
                        index: index!,
                        data: data!
                    } as SaveEntry;
                })));
        promises.push(p);
        console.log(`Finished loading ${name} in ${(Date.now() - start) / 1000}s.`);
    }
}

if (!promises.length)
    console.log("No .txt files found.");
else {
    await Promise.allSettled(promises);
    console.log("Import complete!");
}

// http server
HttpHandler.init(db, "overengineered", 1367);