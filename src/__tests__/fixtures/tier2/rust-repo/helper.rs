pub trait Sink {
    fn drain(&self);
}

pub mod inner {
    pub fn tick() {}
}
