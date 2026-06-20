import { beforeEach, afterEach, test } from "bun:test";
import { WRITE_TOKEN } from "..";
import type { ErrorType } from "../Classes/HttpHandler";

const playerID = "1";
const slotIndex = "31";

//todo add rename + remove + run

// run with 
// bun test .\testing\tests.ts
beforeEach(() =>
{
    console.log("running test.");
});

afterEach(() =>
{
    console.log("done with test.");
});

// tests
test("retrieve player metadata", async () =>
{
    const d = await fetch(`http://localhost:1367/overengineered/player/${playerID}`);
    const parsedData = await d.json();
    if (parsedData.error) throw `Unable to reach example save data: ${parsedData}`;
    console.log("Player meta retrieved and parsed:", parsedData);
});

test("retrieve all player saves", async () =>
{
    const d = await fetch(`http://localhost:1367/overengineered/save/${playerID}`);
    const parsedData = await d.json();
    if (parsedData.error) throw `Unable to reach example save data: ${parsedData}`;
    if (!parsedData.saves) throw `Expected save data, got ${JSON.stringify(parsedData).slice(0, 50)}...`;
    console.log("All saves retrieved and parsed:", parsedData);
});

test("retrieve single player save", async () =>
{
    const d = await fetch(`http://localhost:1367/overengineered/save/${playerID}/${slotIndex}`);
    const parsedData = await d.json();
    if (parsedData.error) throw `Unable to reach example save data: ${parsedData}`;
    if (!parsedData.blocks) throw `Expected save data, got ${JSON.stringify(parsedData).slice(0, 50)}...`;
    console.log("All saves retrieved and parsed:", parsedData);
});


test("retrieve single player save page by page", async () =>
{
    const cachedData: string[] = [];
    let res;
    for (let i = 0; ; i++) {
        const d = await fetch(`http://localhost:1367/overengineered/save/${playerID}/${slotIndex}/${i}`);
        let err;
        const text = await d.text();
        try {
            const j = JSON.parse(text) as { error: string, err_type: ErrorType };
            if (j.error) {
                if (j.err_type === "OUT_OF_INDEX") break;
                err = `Got unexpected error: ${j}`;
                break;
            } else {
                res = j;
                break;
            }
        } catch {
            cachedData.push(text);
        }
        if (err) throw err;
    }

    // parse result
    res ??= JSON.parse(cachedData.join(""));
    if (!res.data) throw `Expected save data, got ${JSON.stringify(res).slice(0, 50)}...`;
    console.log("Single save retrieved page by page and parsed:", res);
});


test("Write save data with token", async () =>
{
    const headers = new Headers({
        'Content-Type': 'application/json',
    });

    const getData = async () =>
    {
        const d = await fetch(`http://localhost:1367/overengineered/save/${playerID}/${slotIndex}`);
        return d.json();
    }

    const writeData = (wd: { [key: string]: unknown }) => fetch(
        `http://localhost:1367/overengineered/save`,
        {
            method: "POST",
            body: JSON.stringify({
                playerID,
                index: slotIndex,
                data: wd,
                token: WRITE_TOKEN,
            }),
            headers
        });

    // begins here
    const before = await getData();

    const writeResult = await writeData(before);
    if (!writeResult.ok) throw "Incorrect data format";

    const after = await getData();
    // console.log(before);
    console.log(after);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw "Written data is not the same as read data."

    // await writeData(before);
    console.log("Single save retrieved page by page and parsed");
});


test("migrate copies player saves WITH their index", async () =>
{
    const B = "http://localhost:1367/overengineered";
    const fromID = playerID;             // "1" — known to have a save at slotIndex with blocks
    const toID = `mtest_${Date.now()}`;  // fresh target each run, so leftovers don't mask bugs

    // sanity: the source save we expect to migrate actually exists
    const srcSave = await (await fetch(`${B}/save/${fromID}/${slotIndex}`)).json();
    if (!srcSave.blocks) throw `Source ${fromID}/${slotIndex} has no blocks to migrate: ${JSON.stringify(srcSave).slice(0, 80)}`;

    // run the migration
    const migrateJson = await (await fetch(`${B}/migrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromID, toID, token: WRITE_TOKEN }),
    })).json();
    if (migrateJson.error) throw `Migration failed: ${JSON.stringify(migrateJson)}`;
    if (migrateJson.metadata !== "SUCCESS" || migrateJson.saves !== "SUCCESS")
        throw `Migration did not report success: ${JSON.stringify(migrateJson)}`;

    // player metadata must land on the target
    const tgtPlayer = await (await fetch(`${B}/player/${toID}`)).json();
    if (tgtPlayer.error) throw `Target player metadata not migrated: ${JSON.stringify(tgtPlayer)}`;

    // THE REGRESSION: the save must be reachable by its index on the target.
    // Before the fix, saves were written with index = NULL, so this 404s.
    const tgtSave = await (await fetch(`${B}/save/${toID}/${slotIndex}`)).json();
    if (tgtSave.error) throw `Migrated save at index ${slotIndex} not found on target (index was lost!): ${JSON.stringify(tgtSave)}`;
    if (!tgtSave.blocks) throw `Migrated save has no blocks: ${JSON.stringify(tgtSave).slice(0, 80)}`;

    // and the data must be identical to the source
    if (JSON.stringify(srcSave) !== JSON.stringify(tgtSave))
        throw `Migrated save differs from source.\n src: ${JSON.stringify(srcSave).slice(0, 120)}\n tgt: ${JSON.stringify(tgtSave).slice(0, 120)}`;

    console.log(`Migration ${fromID} -> ${toID} verified: save index ${slotIndex} copied with matching data.`);
});


test("write player metadata round-trips", async () =>
{
    const B = "http://localhost:1367/overengineered";
    const id = `wtest_${Date.now()}`;
    const data = { seen1: true, marker: `m_${Date.now()}` };

    // write
    const res = await (await fetch(`${B}/player`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerID: id, data, token: WRITE_TOKEN }),
    })).json();
    if (res.status !== "ok") throw `Player write did not return ok: ${JSON.stringify(res)}`;

    // read back
    const back = await (await fetch(`${B}/player/${id}`)).json();
    if (back.error) throw `Could not read back written player: ${JSON.stringify(back)}`;
    if (JSON.stringify(back.data) !== JSON.stringify(data))
        throw `Read-back player data differs.\n wrote: ${JSON.stringify(data)}\n read:  ${JSON.stringify(back.data)}`;

    console.log(`Player write verified for ${id}.`);
});


test("write save data round-trips", async () =>
{
    const B = "http://localhost:1367/overengineered";
    const id = `wtest_${Date.now()}`;
    const index = "7";
    const data = { blocks: [{ id: "test", marker: `m_${Date.now()}` }], version: 1 };

    // write
    const res = await (await fetch(`${B}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerID: id, index, data, token: WRITE_TOKEN }),
    })).json();
    if (res.status !== "ok") throw `Save write did not return ok: ${JSON.stringify(res)}`;

    // read back the single save (GET returns the inner data object directly)
    const back = await (await fetch(`${B}/save/${id}/${index}`)).json();
    if (back.error) throw `Could not read back written save: ${JSON.stringify(back)}`;
    if (JSON.stringify(back) !== JSON.stringify(data))
        throw `Read-back save data differs.\n wrote: ${JSON.stringify(data)}\n read:  ${JSON.stringify(back)}`;

    console.log(`Save write verified for ${id}/${index}.`);
});