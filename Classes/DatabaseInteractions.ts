import { Database } from "bun:sqlite";

export type DataEntry = {
    playerID: string,
    data: string,
}
export type SaveEntry = DataEntry & {
    index: string
}
export type DataResult = {
    playerID: string,
    data: Array<unknown>,
}
export type SaveResult = DataResult & {
    index: string,
}

const destringifyData = (entry: DataEntry): DataResult => ({ ...entry, data: JSON.parse(entry.data) })

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
                player_id TEXT UNIQUE,
                data TEXT
            )
        `);
    }

    export const insertPlayers = (
        db: Database,
        playerData: DataEntry[]
    ) => {
        const prep = db.prepare(`
                INSERT INTO players (player_id, data) 
                VALUES ($player, $data)
                ON CONFLICT(player_id) DO UPDATE SET data = excluded.data
        `);
        db.transaction((data) => {
            for (const d of data) {
                prep.run({ $player: d.playerID, $data: d.data });
            }
        })(playerData);
    }

    export const getDataEntryByID = (db: Database, playerID: string): DataResult => destringifyData(
        db.query(`
            SELECT * FROM players 
            WHERE player_id = ? 
            LIMIT 1
        `).get(playerID) as DataEntry
    )


    // SLOT DATA:
    //  INCREMENT \t INDEX \t USERID \t { "blocks": [ ... ], "version": ## }
    export const initSavesTable = (db: Database) => {
        db.run(`
            CREATE TABLE IF NOT EXISTS saves (
            increment INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT,
            "index" TEXT,
            data TEXT,
            UNIQUE(player_id, "index")
            )
        `);
    }

    export const insertSave = (
        db: Database,
        saveData: SaveEntry[]
    ) => {
        const prep = db.prepare(`
            INSERT INTO saves (player_id, "index", data) 
            VALUES ($player, $index, $data)
            ON CONFLICT(player_id, "index") DO UPDATE SET data = excluded.data
        `);

        db.transaction((data: typeof saveData) => {
            for (const d of data) {
                prep.run({ $player: d.playerID, $index: d.index, $data: d.data });
            }
        })(saveData);
    }

    export const getSavesOfPlayerByID = (db: Database, playerID: string): SaveResult[] =>
        db.query(`
            SELECT * FROM saves
            WHERE player_id = ?
            ORDER BY increment DESC
        `).all(playerID)
            .map(entry => destringifyData(entry as SaveEntry) as SaveResult);


    export const getSavesOfPlayerByIDWithIndex = (db: Database, playerID: string, index: string): SaveResult => destringifyData(
        db.query(`
            SELECT * FROM saves 
            WHERE player_id = ? AND "index" = ?
            ORDER BY increment DESC 
            LIMIT 1
        `).get(playerID, index) as SaveEntry
    ) as SaveResult
}