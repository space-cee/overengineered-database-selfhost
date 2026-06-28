import { Elysia, t } from 'elysia';
import { Database } from "bun:sqlite";
import { ADMIN_TOKEN, isUsingPlaceholderAdminToken, isUsingPlaceholderWriteToken, logMigration, WRITE_TOKEN } from '..';
import { GameEventsHandler } from './GameEventsHandler';
import { DatabaseInteractions, wrapSavePayload, type SavedPlayerFormat, type ParsedSlotFormatWithIndex, type ParsedSlotFormat } from './DatabaseInteractions';

export type ErrorType = "OUT_OF_INDEX" | "NOT_FOUND" | "INCORRECT_TOKEN" | "INSERT_FAIL";
type ErrorCode = { error: string, err_type: ErrorType } | { status: string };
type MigrationResult = { error: string, err_type: ErrorType } | { metadata: string, saves: string }

type PlayerID = string;
type SlotIndex = string;
type PreparedCachedSaveData = {
    data: { [key: string]: unknown },
    slicedData: string[]
    timeout?: ReturnType<typeof setTimeout>
};
const cachedSaveData = new Map<
    PlayerID,
    Map<SlotIndex, PreparedCachedSaveData>
>();

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

const findCachedSaveData = (id: PlayerID, index: SlotIndex) =>
    {
    const playerCached = cachedSaveData.get(id);
    if (!playerCached) {
        cachedSaveData.set(id, new Map());
        return;
    }

    return playerCached.get(index);
};


// for test only
const DISABLE_CACHE = false;

const updateSaveCache = (db: Database, id: PlayerID, index: SlotIndex): PreparedCachedSaveData | undefined =>
{
    if (DISABLE_CACHE) {
        const gotSave = DatabaseInteractions.getSavesOfPlayerByIDWithIndex(db, id, index);
        if (!gotSave) return;
        return { data: gotSave.data, slicedData: splitUtf8(JSON.stringify(gotSave), 1_000_000) };
    }

    let cachedSave = findCachedSaveData(id, index);
    if (!cachedSave) {
        const gotSave = DatabaseInteractions.getSavesOfPlayerByIDWithIndex(db, id, index);
        if (!gotSave) return; // return nothing because nothing to update in the cache

        cachedSave = {
            data: gotSave.data,
            slicedData: splitUtf8(JSON.stringify(gotSave), 1_000_000),
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
        app.get(`/${base}/player/:id`, ({ params: { id } }): ErrorCode | SavedPlayerFormat =>
        {
            const player = DatabaseInteractions.getPlayerDataEntryByID(db, id);
            return player ?? { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read all saves by player id
        app.get(`/${base}/save/:id`, ({ params: { id } }): ErrorCode | { saves: ParsedSlotFormat["data"][] } =>
        {
            const saves = DatabaseInteractions.getSavesOfPlayerByID(db, id);
            return saves ? { saves: saves.map(s => s.data) } : { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read single save by player id
        app.get(`/${base}/save/:id/:index`, ({ params: { id, index } }): ErrorCode | string =>
        {
            const save = updateSaveCache(db, id, index);
            if (save) return JSON.stringify(save.data);
            return { error: 'Not found', err_type: "NOT_FOUND" };
        });

        // read single save by player id by page 
        app.get(`/${base}/save/:id/:index/:page`, ({ params: { id, index, page } }): ErrorCode | string => 
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
        app.post(`/${base}/player`, ({ body }): ErrorCode =>
        {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
            if (!Object.keys(body.data).length) return { error: "Incorrect body data type", err_type: "INSERT_FAIL" };
            return DatabaseInteractions.insertPlayers(db, [body]) === "SUCCESS"
                ? { status: 'ok' }
                : { error: "Error while upserting player metadata", err_type: "INSERT_FAIL" };
        }, {
            body: t.Object({
                playerID: t.String(),
                data: t.Record(t.String(), t.Any()),
                token: t.String(),
            })
        });

        // write save (I'm not doing batches)
        app.post(`/${base}/save`, ({ body }): ErrorCode => 
            {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };
            if (!Object.keys(body.data).length) return { error: "Incorrect body data type", err_type: "INSERT_FAIL" };

            const wrappedSaveData = wrapSavePayload(body.data);
            const insertResult = DatabaseInteractions.insertSave(db, [{ ...body, data: wrappedSaveData }]);
            if (insertResult === "FAIL") return { error: "Error while upserting save data", err_type: "INSERT_FAIL" };

            // clear cache
            const oldSave = cachedSaveData.get(body.playerID)?.get(body.index);
            clearTimeout(oldSave?.timeout);

            // make new thing
            const saveForCache: PreparedCachedSaveData = {
                data: body.data,
                slicedData: splitUtf8(JSON.stringify(body.data), 1_000_000),

                // remove that from the cache after 30 mins
                timeout: setTimeout(
                    () => cachedSaveData.get(body.playerID)?.delete(body.index),
                    30 * 60 * 1_000
                )
            };

            const playerCache = cachedSaveData.get(body.playerID) ?? new Map<SlotIndex, PreparedCachedSaveData>();
            cachedSaveData.set(body.playerID, playerCache);
            playerCache.set(body.index, saveForCache);


            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                index: t.String(),
                data: t.Record(t.String(), t.Any()),
                token: t.String(),
            })
        });

        // copies saves of one person to saves of another person
        app.post(`/${base}/migrate`, ({ body }): MigrationResult =>
        {
            if (isUsingPlaceholderWriteToken) return { error: "Using placeholder token", err_type: "INCORRECT_TOKEN" };
            if (body.token !== WRITE_TOKEN) return { error: "Incorrect token", err_type: "INCORRECT_TOKEN" };

            // Migrate metadata
            const metadata = DatabaseInteractions.getPlayerDataEntryByID(db, body.fromID);
            if (!metadata) return { error: `No meta data from playerID ${body.fromID} was found`, err_type: "NOT_FOUND" }
            const migratedPlayer = { ...metadata, playerID: body.toID, data: metadata!.data } as SavedPlayerFormat;

            // Migrate saves — each keeps its own index.
            const allSaves = DatabaseInteractions.getSavesOfPlayerByID(db, body.fromID);
            if (!allSaves.length) return { error: `No save data from playerID ${body.fromID} was found`, err_type: "NOT_FOUND" }
            const migratedSave = allSaves.map(v => ({ ...v, playerID: body.toID })) as ParsedSlotFormatWithIndex[];

            logMigration({ migratedPlayer, migratedSave })

            return {
                metadata: DatabaseInteractions.insertPlayers(db, [migratedPlayer]),
                saves: DatabaseInteractions.insertSave(db, migratedSave)
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

