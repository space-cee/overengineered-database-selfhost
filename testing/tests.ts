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