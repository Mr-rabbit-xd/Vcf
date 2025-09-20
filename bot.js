const { Telegraf, Markup, session } = require('telegraf');
const admin = require('firebase-admin');
const fs = require('fs');
const cron = require('node-cron');
const config = require('./config');

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: config.FIREBASE.project_info.firebase_url,
  storageBucket: config.FIREBASE.project_info.storage_bucket
});
const db = admin.firestore();

// Initialize Telegram Bot
const bot = new Telegraf(config.TELEGRAM_TOKEN);
bot.use(session());

// ---- Main Menu ----
bot.start(async (ctx) => {
  // Save user if not exist
  const userRef = db.collection("users").doc(ctx.from.id.toString());
  const doc = await userRef.get();
  if(!doc.exists){
    await userRef.set({
      joinedAt: admin.firestore.Timestamp.now(),
      type: 'telegram'
    });
  }

  return ctx.reply(
    'Welcome! Choose an option:',
    Markup.keyboard([
      ['Add Contact', 'Download VCF'],
      ['Help']
    ]).resize()
  );
});

// ---- Help ----
bot.hears('Help', (ctx) => {
  ctx.reply('📌 Bot Commands:\n- Add Contact: Step-by-step Name+Number\n- Download VCF: Must have added at least 1 contact and joined before last monthly update');
});

// ---- Add Contact ----
bot.hears('Add Contact', (ctx) => {
  ctx.session.addContact = { step: 'name' };
  ctx.reply('Step 1/2: Enter Name of the contact:');
});

// ---- Download VCF ----
bot.hears('Download VCF', async (ctx) => {
  try {
    const userDoc = await db.collection("users").doc(ctx.from.id.toString()).get();
    if(!userDoc.exists) return ctx.reply("❌ You are not registered.");

    // Check if user added at least 1 contact
    const contactsSnap = await db.collection("contacts")
      .where("addedBy", "==", ctx.from.id.toString())
      .get();
    if(contactsSnap.empty) return ctx.reply("❌ Add at least one contact first.");

    // Check monthly VCF access
    const vcfDoc = await db.collection("master_vcf").doc("latest").get();
    const updatedAt = vcfDoc.data().updatedAt.toDate();
    if(userDoc.data().joinedAt.toDate() < updatedAt){
      const vcfUrl = vcfDoc.data().url;
      ctx.reply(`✅ Download latest VCF:\n${vcfUrl}`);
    } else {
      ctx.reply("❌ You cannot access this month's VCF yet.");
    }

  } catch (e) {
    console.error(e);
    ctx.reply("❌ Error fetching VCF.");
  }
});

// ---- Step-by-step Contact Add ----
bot.on('text', async (ctx) => {
  if(ctx.session.addContact){
    const step = ctx.session.addContact.step;
    const text = ctx.message.text.trim();

    if(step === 'name'){
      ctx.session.addContact.name = text;
      ctx.session.addContact.step = 'phone';
      return ctx.reply('Step 2/2: Enter WhatsApp Number with country code (e.g. +8801712345678):');
    }

    if(step === 'phone'){
      if(!text.match(/^\+\d{6,15}$/)) return ctx.reply("❌ Invalid number format. Try again.");
      ctx.session.addContact.phone = text;

      // Save to Firebase
      await db.collection('contacts').add({
        name: ctx.session.addContact.name,
        phone: ctx.session.addContact.phone,
        addedBy: ctx.from.id.toString()
      });

      // Notify Admin
      await bot.telegram.sendMessage(config.ADMIN_ID, `New contact added:\nName: ${ctx.session.addContact.name}\nPhone: ${ctx.session.addContact.phone}`);

      ctx.reply(`✅ Contact saved: ${ctx.session.addContact.name} - ${ctx.session.addContact.phone}`);
      ctx.session.addContact = null;
    }
  }
});

// ---- Monthly VCF Auto-Update ----
cron.schedule('0 0 1 * *', async () => {
  try {
    const snapshot = await db.collection('contacts').get();
    if(snapshot.empty) return;

    let vcfData = '';
    snapshot.forEach(doc => {
      const c = doc.data();
      vcfData += `BEGIN:VCARD\nVERSION:3.0\nFN:${c.name}\nTEL;TYPE=CELL:${c.phone}\nEND:VCARD\n`;
    });

    // Save file
    const dir = './vcf';
    if(!fs.existsSync(dir)) fs.mkdirSync(dir);
    const fileName = `${dir}/master_contacts.vcf`;
    fs.writeFileSync(fileName, vcfData);

    // Update Firestore
    await db.collection('master_vcf').doc('latest').set({
      url: 'https://yourserver.com/vcf/master_contacts.vcf', // host file link
      updatedAt: admin.firestore.Timestamp.now()
    });

    console.log("✅ Master VCF updated!");
  } catch(e){
    console.error(e);
  }
});

bot.launch();
console.log("✅ Telegram Bot running with button system, Firebase and auto monthly VCF.");
