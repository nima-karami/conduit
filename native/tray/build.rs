fn main() {
    println!("cargo:rerun-if-changed=res/conduit-tray.rc");
    println!("cargo:rerun-if-changed=res");

    if std::env::var("HOST")
        .ok()
        .as_deref()
        .is_some_and(|host| host.contains("windows"))
        && std::env::var("TARGET")
            .ok()
            .as_deref()
            .is_some_and(|target| target.contains("windows"))
    {
        embed_resource::compile("res/conduit-tray.rc", embed_resource::NONE)
            .manifest_optional()
            .expect("tray resources should compile");
    }
}
