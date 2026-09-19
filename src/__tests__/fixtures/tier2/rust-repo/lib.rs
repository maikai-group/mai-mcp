use std::collections::HashMap;

pub struct Store {
    inner: HashMap<String, String>,
}

impl Store {
    pub fn get(&self) -> usize {
        depth()
    }
}

fn depth() -> usize {
    7
}
