import { ContentCreator } from "./contentCreator.ts";
import { Entity } from "./db.ts";
export type ManagerState = "online" | "offline" | "turningOff" | "stuck";
interface ManagerData {
    id: string;
    state: ManagerState;
    updatedAt: string;
    createdAt: string;
}
export declare class Manager extends Entity<ManagerData> {
    table: string;
    get state(): ManagerState;
    set state(s: ManagerState);
    private _contentCreators;
    get contentCreators(): (ContentCreator | undefined)[];
    loadContentCreators(): Promise<void>;
    addContentCreator(cc: ContentCreator): Promise<void>;
    removeContentCreator(cc: ContentCreator): Promise<void>;
    onLoad(): Promise<void>;
    shutdown(): Promise<void>;
    toString(): string;
}
export {};
//# sourceMappingURL=manager.d.ts.map