import { Elysia, t } from 'elysia';
import { Database } from "bun:sqlite";
import { ADMIN_TOKEN, isUsingPlaceholderAdminToken, isUsingPlaceholderWriteToken, logMigration, WRITE_TOKEN } from '..';
import { GameEventsHandler } from './GameEventsHandler';
import { DatabaseInteractions, type SavedPlayerFormat, type ParsedSlotFormatWithIndex, type ParsedSlotFormat } from './DatabaseInteractions';

export type ErrorType = "OUT_OF_INDEX" | "NOT_FOUND" | "INCORRECT_TOKEN";
type ErrorCode = { error: string, err_type: ErrorType } | { status: string };
type MigrationResult = { error: string, err_type: ErrorType } | { metadata: string, saves: string }

type PlayerID = string;
type SlotIndex = string;
type PreparedCachedSaveData = {
    data: Array<unknown>,
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


const updateSaveCache = (db: Database, id: PlayerID, index: SlotIndex): PreparedCachedSaveData | undefined =>
{
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
        app.get(`/${base}/save/:id`, ({ params: { id } }): ErrorCode | { saves: (ParsedSlotFormat | undefined)[] } =>
        {
            const saves = DatabaseInteractions.getSavesOfPlayerByID(db, id);
            return saves ? { saves } : { error: 'Not found', err_type: "NOT_FOUND" };
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
            DatabaseInteractions.insertPlayers(db, [body]);
            return { status: 'ok' };
        }, {
            body: t.Object({
                playerID: t.String(),
                data: t.Object(t.Unknown()),
                token: t.String(),
            })
        });

        // write save (I'm not doing batches)
        app.post(`/${base}/save`, ({ body }): ErrorCode =>
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
                slicedData: splitUtf8(JSON.stringify(body.data), 1_000_000),

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
                data: t.Array(t.Unknown()),
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

            // Migrate saves
            const allSaves = DatabaseInteractions.getSavesOfPlayerByID(db, body.fromID);
            if (!allSaves) return { error: `No save data from playerID ${body.fromID} was found`, err_type: "NOT_FOUND" }
            const migratedSave = allSaves.map(v => (({ ...v, playerID: body.toID, data: v!.data }))) as ParsedSlotFormatWithIndex[];

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

