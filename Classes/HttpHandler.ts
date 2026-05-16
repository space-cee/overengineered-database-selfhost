import { Elysia, t } from 'elysia';
import { DatabaseInteractions, type DataEntry, type DataResult, type SaveEntry, type SaveResult } from './DatabaseInteractions';
import { Database } from "bun:sqlite";
import { ADMIN_TOKEN, isUsingPlaceholderAdminToken, isUsingPlaceholderWriteToken, logMigration, WRITE_TOKEN } from '..';
import { GameEventsHandler } from './GameEventsHandler';


// AI slop here :)
function splitUtf8(str: string, maxBytes = 4096)
{
    const buffer = Buffer.from(str, 'utf8');
    const chunks = [];
    let offset = 0;

    while (offset < buffer.length) {
        let end = offset + maxBytes;

        while (end > offset && (buffer[end]! & 0xC0) === 0x80) {
            end--;
        }

        if (end === offset) {
            const byte = buffer[offset]!;
            let charLen = 1;
            if ((byte & 0xE0) === 0xC0) charLen = 2;
            else if ((byte & 0xF0) === 0xE0) charLen = 3;
            else if ((byte & 0xF8) === 0xF0) charLen = 4;
            end = offset + charLen;
        }

        chunks.push(buffer.subarray(offset, end).toString('utf8'));
        offset = end;
    }

    return chunks;
}

type playerID = string;
type slotIndex = string;
type errType = "OUT_OF_INDEX" | "NOT_FOUND" | "INCORRECT_TOKEN";
type errcode = { error: string, err_type: errType } | { status: string };
type MigrationResult = { error: string, err_type: errType } | { metadata: string, saves: string }
type preparedCachedSaveData = {
    data: string,
    slicedData: string[]
    timeout?: ReturnType<typeof setTimeout>
};

const cachedSaveData = new Map<
    playerID,
    Map<slotIndex, preparedCachedSaveData>
>();

const findCachedSaveData = (id: playerID, index: slotIndex) =>
{
    const playerCached = cachedSaveData.get(id);
    if (!playerCached) {
        cachedSaveData.set(id, new Map());
        return;
    }

    return playerCached.get(index);
};


const updateSaveCache = (db: Database, id: playerID, index: slotIndex): preparedCachedSaveData | undefined =>
{
    let cachedSave = findCachedSaveData(id, index);
    if (!cachedSave) {
        const gotSave = DatabaseInteractions.getSavesOfPlayerByIDWithIndex(db, id, index);
        if (!gotSave) return; // return nothing because nothing to update in the cache

        // super duper fix
        if (typeof gotSave.data === "string")
            gotSave.data = JSON.parse(gotSave.data);

        const saveStr = JSON.stringify(gotSave);
        cachedSave = {
            data: saveStr,
            slicedData: splitUtf8(saveStr, 1_000_000),
        };
        cachedSaveData.get(id)!.set(index, cachedSave);
    }

    clearTimeout(cachedSave.timeout);
    cachedSave.timeout = setTimeout(
        () => cachedSaveData.get(id)?.delete(index),
        30 * 60 * 1_000
    );

    return cachedSave;
}

export namespace HttpHandler
{
    export const init = (db: Database, base: string, port: number) =>
    {
        const app = new Elysia();
        app.listen(port);

        // read player data by id
        app.get(`/${base}/player/:id`, ({ params: { id } }): errcode | DataResult =>
        {
            const player = DatabaseInteractions.getDataEntryByID(db, id);
            return player ?? { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read all saves by player id
        app.get(`/${base}/save/:id`, ({ params: { id } }): errcode | { saves: (SaveResult | undefined)[] } =>
        {
            const saves = DatabaseInteractions.getSavesOfPlayerByID(db, id);
            return saves ? { saves } : { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read single save by player id
        app.get(`/${base}/save/:id/:index`, ({ params: { id, index } }): errcode | string =>
        {
            const save = updateSaveCache(db, id, index);
            return save?.data ?? { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read single save by player id by page 
        app.get(`/${base}/save/:id/:index/:page`, ({ params: { id, index, page } }): errcode | string =>
        {
            const pg = Number(page);
            if (isNaN(pg)) return { error: 'No page found', err_type: "NOT_FOUND" };

            const save = updateSaveCache(db, id, index);
            if (!save) return { error: 'Not found', err_type: "NOT_FOUND" };

            const indexOutOfBounds = pg > save.slicedData.length - 1;
            return indexOutOfBounds ?
                { error: 'Page out of index', err_type: "OUT_OF_INDEX" } :
                save?.slicedData[pg] ?? { error: 'Not found', err_type: "NOT_FOUND" };
        });

        //get events
        app.get(`/${base}/events`, ({ query }) =>
            GameEventsHandler.getEventsAfterTimestamp(query.time),
            {
                query: t.Object({
                    time: t.Number()
                })
            });

        //get events
        app.post(`/${base}/events`, ({ body }) =>
        {
            if (isUsingPlaceholderAdminToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== ADMIN_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
            GameEventsHandler.addEvent(body.data);
            return { status: "ok" };
        },
            {
                body: t.Object({
                    data: t.Any(),
                    token: t.String()
                })
            });

        // write player
        app.post(`/${base}/player`, ({ body }): errcode =>
        {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
            DatabaseInteractions.insertPlayers(db, [body]);
            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                data: t.String(),
                token: t.String(),
            })
        });

        // write save (I'm not doing batches)
        app.post(`/${base}/save`, ({ body }): errcode =>
        {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
            DatabaseInteractions.insertSave(db, [body]);

            // clear cache
            const oldSave = cachedSaveData.get(body.playerID)?.get(body.index);
            clearTimeout(oldSave?.timeout);

            // make new thing
            const saveForCache = {
                data: body.data,
                slicedData: splitUtf8(body.data, 1_000_000),

                // remove that from the cache after 30 mins
                timeout: setTimeout(
                    () => cachedSaveData.get(body.playerID)?.delete(body.index),
                    30 * 60 * 1_000
                )
            };

            cachedSaveData.get(body.playerID)?.set(body.index, saveForCache);


            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                index: t.String(),
                data: t.String(),
                token: t.String(),
            })
        });

        // copies saves of one person to saves of another person
        app.post(`/${base}/migrate`, ({ body }): MigrationResult =>
        {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };

            // Migrate metadata
            const metadata = DatabaseInteractions.getDataEntryByID(db, body.fromID);
            if (!metadata) return { error: `No meta data from PlayerID ${body.fromID} was found`, err_type: "NOT_FOUND" }
            const newdata = { ...metadata, playerID: body.toID, data: JSON.stringify(metadata!.data) } as DataEntry

            // Migrate saves
            const allSaves = DatabaseInteractions.getSavesOfPlayerByID(db, body.fromID);
            if (!allSaves) return { error: `No save data from PlayerID ${body.fromID} was found`, err_type: "NOT_FOUND" }
            const migratedData: SaveEntry[] = allSaves.map(v => (({ ...v, playerID: body.toID, data: JSON.stringify(v!.data) })));

            logMigration({ migratedPlayer: newdata, migratedSave: migratedData })

            return {
                metadata: DatabaseInteractions.insertPlayers(db, [newdata]),
                saves: DatabaseInteractions.insertSave(db, migratedData)
            };
        }, {
            body: t.Object({
                fromID: t.String(),
                toID: t.String(),
                token: t.String(),
            })
        });

        console.log(`HTTP is running on http://localhost:${port}`);
    }
}
