export interface IdGenerator {
  next(): string;
}

export interface Clock {
  now(): Date;
}

export const ID_GENERATOR = Symbol('IdGenerator');
export const CLOCK = Symbol('Clock');
