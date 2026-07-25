import { type Pool } from "mysql2/promise";
export declare function getPool(): Pool;
export interface EntityData {
    id: string;
    updatedAt: string;
    createdAt: string;
}
export type NonstaticField<T extends EntityData> = Omit<T, "id" | "updatedAt" | "createdAt">;
export declare abstract class Entity<T extends EntityData> {
    abstract table: string;
    protected pool: Pool;
    protected data: T;
    get id(): string;
    get updatedAt(): Date;
    get createdAt(): Date;
    abstract toString(): string;
    abstract onLoad(): Promise<void>;
    protected constructor(id: string);
    static load<C extends typeof Entity<any>>(this: C, id?: string): Promise<C["prototype"] | undefined>;
    set(column: keyof NonstaticField<T>, value: any): Promise<boolean>;
    fetch(): Promise<boolean>;
    create(): Promise<boolean>;
}
//# sourceMappingURL=db.d.ts.map