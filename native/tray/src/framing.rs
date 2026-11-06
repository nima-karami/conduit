use std::io::Read;

pub const MAX_LINE_BYTES: usize = 65_536;

#[derive(Debug)]
pub enum FrameError {
    Io(std::io::Error),
    InvalidUtf8(std::string::FromUtf8Error),
    TooLong,
}

pub struct LineReader<R> {
    reader: R,
    buffer: Vec<u8>,
}

impl<R: Read> LineReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: Vec::new(),
        }
    }

    pub fn read_line(&mut self) -> Result<Option<String>, FrameError> {
        loop {
            let mut byte = [0_u8; 1];
            match self.reader.read(&mut byte) {
                Ok(0) if self.buffer.is_empty() => return Ok(None),
                Ok(0) => return self.take_line(),
                Ok(_) if byte[0] == b'\n' => return self.take_line(),
                Ok(_) => {
                    self.buffer.push(byte[0]);
                    if self.buffer.len() > MAX_LINE_BYTES {
                        return Err(FrameError::TooLong);
                    }
                }
                Err(error) => return Err(FrameError::Io(error)),
            }
        }
    }

    fn take_line(&mut self) -> Result<Option<String>, FrameError> {
        if self.buffer.last() == Some(&b'\r') {
            self.buffer.pop();
        }
        String::from_utf8(std::mem::take(&mut self.buffer))
            .map(Some)
            .map_err(FrameError::InvalidUtf8)
    }
}

#[cfg(test)]
mod tests {
    use super::{FrameError, LineReader, MAX_LINE_BYTES};
    use std::io::Cursor;

    #[test]
    fn reads_one_utf8_json_object_per_line() {
        let mut reader = LineReader::new(Cursor::new(b"{\"type\":\"exit\"}\r\n".to_vec()));
        assert_eq!(
            reader.read_line().expect("valid frame").as_deref(),
            Some("{\"type\":\"exit\"}")
        );
        assert!(reader.read_line().expect("eof").is_none());
    }

    #[test]
    fn rejects_a_line_over_the_protocol_limit() {
        let input = vec![b'x'; MAX_LINE_BYTES + 1];
        let mut reader = LineReader::new(Cursor::new(input));
        assert!(matches!(reader.read_line(), Err(FrameError::TooLong)));
    }
}
