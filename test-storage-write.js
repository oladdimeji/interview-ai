import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const bucketName = 'gen-lang-client-0637900846.firebasestorage.app';

async function testWrite() {
  try {
    console.log(`Attempting to upload a test file to: ${bucketName}`);
    const bucket = storage.bucket(bucketName);
    const file = bucket.file('test-file.txt');
    
    await file.save('Hello, this is a server-side storage write test!', {
      metadata: {
        contentType: 'text/plain',
      },
    });
    
    console.log('SUCCESS! Test file written successfully.');
    
    // Now, let's check if we can make it public or read it back/get its public URL
    const publicUrl = `https://storage.googleapis.com/${bucketName}/test-file.txt`;
    console.log(`Public URL guess: ${publicUrl}`);
    
    // Check if we can get a download URL or signed URL or just the file's metadata
    const [metadata] = await file.getMetadata();
    console.log(`File metadata:`, metadata);
  } catch (error) {
    console.error('Test write failed:', error);
  }
}

testWrite();
