import { beforeEach, afterEach, test } from "bun:test";
import type { errType } from "../Classes/HttpHandler";
import { WRITE_TOKEN } from "..";

const playerID = "238427763";
const slotIndex = "31";

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
    await d.json();
});

test("retrieve all player saves", async () =>
{
    const d = await fetch(`http://localhost:1367/overengineered/save/${playerID}`);
    const parsedData = await d.json();
    if (parsedData.error) throw "Unable to reach example save data"
    console.log("All saves retrieved and parsed");
});

test("retrieve single player save", async () =>
{
    const d = await fetch(`http://localhost:1367/overengineered/save/${playerID}/${slotIndex}`);
    const parsedData = await d.json();
    if (parsedData.error) throw "Unable to reach example save data"
    console.log("Single save retrieved and parsed");
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
            const j = JSON.parse(text) as { error: string, err_type: errType };
            if (j.err_type) {
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
    console.log("Single save retrieved page by page and parsed");
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

    const before = await getData();
    before.testString ??= "a";
    before.testString += "b";
    if (before.testString.length > 100) before.testString = "a";

    const data: {}[] = before;
    const writeResult = await fetch(
        `http://localhost:1367/overengineered/save`,
        {
            method: "POST",
            body: JSON.stringify({
                playerID,
                index: slotIndex,
                data,
                token: WRITE_TOKEN,
            }),
            headers
        });

    if (!writeResult.ok) throw "Incorrect data format";

    const after = await getData();
    if (JSON.stringify(before) === JSON.stringify(after)) throw "Written data is the same as read data."

    console.log("Single save retrieved page by page and parsed");
});