import { Entity } from "./db.ts";
export type VideoState = "notStarted" | "workingOn" | "finished";
interface VideoData {
    id: string;
    contentCreatorID?: string;
    state: VideoState;
    updatedAt: string;
    createdAt: string;
}
export declare class Video extends Entity<VideoData> {
    table: string;
    private _contentCreator;
    get contentCreator(): any;
    setContentCreator(cc: any): Promise<void>;
    get state(): VideoState;
    set state(s: VideoState);
    onLoad(): Promise<void>;
    toString(): string;
}
export {};
//# sourceMappingURL=video.d.ts.map