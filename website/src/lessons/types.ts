export type Lesson = {
    id: string;
    number: number;
  title: string;
    goal: string;
    body: string;
    starter: string;
    assets: Record<string, string>;
};

export type Module = {
    id: string;
  number: number;
  title: string;
    blurb: string;
  lessons: Lesson[];
};

export type Track = {
  id: string;
  number: number;
  title: string;
    tagline: string;
  modules: Module[];
};
