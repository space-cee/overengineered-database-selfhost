import { Database } from "bun:sqlite";

export type DataEntry = {
    playerID: string,
    data: string,
}

export type DataResult = {
    playerID: string,
    data: Array<unknown>,
}

export type SaveEntry = DataEntry & {
    index: string
}

export type SaveResult = DataResult & {
    index: string,
}

export type InteractionResult = "SUCCESS" | "FAIL"

const destringifyData = (entry: DataEntry | undefined): DataResult | undefined => {
    if (!entry) return undefined
    return ({ ...entry, data: JSON.parse(entry.data) })
}

export namespace DatabaseInteractions {
    /* USERID \t {
         "data": { ... }, 
         "slots": [ ... ],
         "features": [ ... ],
         "settings": { ... },
         "achievements": { ... }
        }
    */
    export const initPlayerTable = (db: Database) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS players (
                playerID TEXT UNIQUE,
                data TEXT
            )
        `);
    }

    export const insertPlayers = (
        db: Database,
        playerData: DataEntry[]
    ): InteractionResult => {
        try {
            const prep = db.prepare(`
                INSERT INTO players (playerID, data) 
                VALUES ($player, $data)
                ON CONFLICT(playerID) DO UPDATE SET data = excluded.data
        `);
            db.transaction((data) => {
                for (const d of data) {
                    prep.run({ $player: d.playerID, $data: d.data });
                }
            })(playerData);
        } catch {
            return "FAIL"
        }
        return "SUCCESS"
    }

    export const getDataEntryByID = (db: Database, playerID: string): DataResult | undefined => destringifyData(
        db.query(`
            SELECT * FROM players 
            WHERE playerID = ? 
            LIMIT 1
        `).get(playerID) as DataEntry
    )


    // SLOT DATA:
    //  INCREMENT \t INDEX \t USERID \t { "blocks": [ ... ], "version": ## }
    export const initSavesTable = (db: Database) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS saves (
            increment INTEGER PRIMARY KEY AUTOINCREMENT,
            playerID TEXT,
            "index" TEXT,
            data TEXT,
            UNIQUE(playerID, "index")
            )
        `);
    }

    export const insertSave = (
        db: Database,
        saveData: SaveEntry[]
    ): InteractionResult => {
        try {
            const prep = db.prepare(`
            INSERT INTO saves (playerID, "index", data) 
            VALUES ($player, $index, $data)
            ON CONFLICT(playerID, "index") DO UPDATE SET data = excluded.data
        `);

            db.transaction((data: typeof saveData) => {
                for (const d of data) {
                    prep.run({ $player: d.playerID, $index: d.index, $data: d.data });
                }
            })(saveData);
        } catch {
            return "FAIL"
        }
        return "SUCCESS"
    }

    export const getSavesOfPlayerByID = (db: Database, playerID: string): SaveResult[] | undefined =>
        db.query(`
            SELECT * FROM saves
            WHERE playerID = ?
            ORDER BY increment DESC
        `).all(playerID)?.map(entry => destringifyData(entry as SaveEntry) as SaveResult);

    export const getSavesOfPlayerByIDWithIndex = (db: Database, playerID: string, index: string): SaveResult | undefined => destringifyData(
        db.query(`
            SELECT * FROM saves 
            WHERE playerID = ? AND "index" = ?
            ORDER BY increment DESC 
            LIMIT 1
        `).get(playerID, index) as SaveEntry | undefined
    ) as SaveResult | undefined
}