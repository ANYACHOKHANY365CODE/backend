import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import axios from 'axios';
import PDFDocument from 'pdfkit';
import getStream from 'get-stream';
import { PassThrough } from 'stream';
import cron from 'node-cron';

dotenv.config();

// Debug: print if OPENAI_API_KEY is loaded (mask for safety)
if (process.env.OPENAI_API_KEY) {
  const key = process.env.OPENAI_API_KEY;
  console.log('OPENAI_API_KEY loaded:', key.slice(0, 6) + '...' + key.slice(-4));
} else {
  console.log('OPENAI_API_KEY NOT loaded');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const openai = new OpenAI({
  apiKey: process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_SERVICE_KEY
);

const supabaseAdmin = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware to get user from Bearer token
const getUser = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Authentication token not provided.' });
  }
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
  req.user = user;
  next();
};

app.delete('/api/delete-account', getUser, async (req, res) => {
  const userId = req.user.id;
  console.log(`Attempting to delete account for user: ${userId}`);

  try {
    // The Supabase project should have cascade deletes set up on the 'profiles' table.
    // If not, you must manually delete related data from other tables first:
    // e.g., vet_bookings, reminders, medical_records, pets, etc.
    // Assuming cascade delete is enabled for simplicity.

    const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (deleteUserError) {
      console.error(`Error deleting user ${userId} from auth:`, deleteUserError);
      throw new Error(deleteUserError.message);
    }
    
    console.log(`Successfully deleted user ${userId}`);
    res.status(200).json({ message: 'Account deleted successfully.' });

  } catch (error) {
    console.error(`Failed to delete account for user ${userId}:`, error);
    res.status(500).json({ message: `An error occurred during account deletion: ${error.message}` });
  }
});

// In-memory chat history (for demo; replace with DB for persistence)
let chatHistory = [];

app.get('/api/chat/history', (req, res) => {
  // Optionally filter by user_id and pet_id if provided
  const { user_id, pet_id } = req.query;
  // For now, just return the whole history
  res.json({ history: chatHistory });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, context, attachment } = req.body;
    const { user, pet } = context;

    // Helper functions for summarization
    function summarizeReminders(reminders) {
      if (!reminders || reminders.length === 0) return 'No reminders.';
      const overdue = reminders.filter(r => r.status === 'overdue' || (r.due_date && new Date(r.due_date) < new Date() && r.status !== 'completed')).length;
      const recurring = reminders.filter(r => r.is_recurring).length;
      return `${reminders.length} total, ${overdue} overdue, ${recurring} recurring. Most recent: "${reminders[0]?.title || reminders[0]?.description || 'N/A'}"`;
    }
    function summarizeRecords(records) {
      if (!records || records.length === 0) return 'No medical records.';
      const byType = {};
      records.forEach(r => {
        if (r.type) byType[r.type] = (byType[r.type] || 0) + 1;
      });
      const typeSummary = Object.entries(byType).map(([type, count]) => `${count} ${type}`).join(', ');
      return `${records.length} records${typeSummary ? ', ' + typeSummary : ''}. Most recent: "${records[0]?.title || 'N/A'}"`;
    }
    function summarizeLogs(logs) {
      if (!logs || logs.length === 0) return 'No logs.';
      return `${logs.length} actions in last week. Most recent: ${logs[0]?.action || logs[0]?.event || 'N/A'}`;
    }
    // Sort and select most recent 5 for each
    const reminders = (context.reminders || []).sort((a, b) => new Date(b.due_date || b.date) - new Date(a.due_date || a.date)).slice(0, 5);
    const records = (context.medical_records || []).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
    const logs = (context.logs || []).sort((a, b) => new Date(b.date || b.timestamp) - new Date(a.date || a.timestamp)).slice(0, 5);

    // Truncate large fields in reminders, records, logs
    function truncateField(obj, field, maxLen = 500) {
      if (obj[field] && typeof obj[field] === 'string' && obj[field].length > maxLen) {
        obj[field] = obj[field].slice(0, maxLen) + '... [truncated]';
      }
    }
    const safeReminders = reminders.map(r => {
      const copy = { ...r };
      truncateField(copy, 'description');
      return copy;
    });
    const safeRecords = records.map(r => {
      const copy = { ...r };
      truncateField(copy, 'description');
      truncateField(copy, 'extractedText');
      if (copy.files) delete copy.files;
      return copy;
    });
    const safeLogs = logs.map(l => ({ ...l }));

    // Compose context prompt
    let contextPrompt = '';
    if (context) {
      contextPrompt = "Here is the user's current context. Use this to answer the user's question. Use the exact data as provided. Do not omit any details. Do not mention that you have this context unless it's directly relevant to the user's question.\n\n";
        if (context.user?.name) {
            contextPrompt += `User's Name: ${context.user.name}\n`;
        }
        if (context.pet) {
        // Only include basic fields, not nested arrays/objects
        const { id, name, species, breed, age, gender, color, weight, notes } = context.pet || {};
        const petSummary = { id, name, species, breed, age, gender, color, weight, notes };
        contextPrompt += `\nActive Pet Profile:\n` + JSON.stringify(petSummary, null, 2) + '\n';
      }
      // Summaries and recent entries (only sliced arrays, truncated fields)
      contextPrompt += `\nReminders Summary:\n${summarizeReminders(safeReminders)}\nRecent Reminders (up to 5):\n` + JSON.stringify(safeReminders, null, 2) + '\n';
      contextPrompt += `\nMedical Records Summary:\n${summarizeRecords(safeRecords)}\nRecent Medical Records (up to 5):\n` + JSON.stringify(safeRecords, null, 2) + '\n';
      contextPrompt += `\nLogs Summary:\n${summarizeLogs(safeLogs)}\nRecent Logs (up to 5):\n` + JSON.stringify(safeLogs, null, 2) + '\n';
    }

    // Direct response for extracted text requests
    if (
      /text.*last.*doc|extracted.*text.*last/i.test(message) ||
      /content.*last.*document/i.test(message)
    ) {
      const lastDoc = (context.medical_records || []).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      if (lastDoc && (lastDoc.description || lastDoc.extractedText)) {
        chatHistory.push({ role: 'user', content: message });
        chatHistory.push({ role: 'assistant', content: lastDoc.description || lastDoc.extractedText });
        return res.json({ response: lastDoc.description || lastDoc.extractedText });
      } else {
        chatHistory.push({ role: 'user', content: message });
        chatHistory.push({ role: 'assistant', content: 'No document found or no extracted text available.' });
        return res.json({ response: 'No document found or no extracted text available.' });
      }
    }

    // If user asks for last document details (not just text)
    if (/last.*doc(ument)?( details| info| information)?/i.test(message)) {
      const lastDoc = (context.medical_records || []).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      if (lastDoc) {
        const details = `Title: ${lastDoc.title}\nDate: ${lastDoc.date}\n${lastDoc.description || lastDoc.extractedText || ''}`;
        chatHistory.push({ role: 'user', content: message });
        chatHistory.push({ role: 'assistant', content: details });
        return res.json({ response: details });
      } else {
        chatHistory.push({ role: 'user', content: message });
        chatHistory.push({ role: 'assistant', content: 'No document found.' });
        return res.json({ response: 'No document found.' });
      }
    }

    // If user asks for prescribed medicines and frequency from all docs
    if (/medicine|medication|prescribe|frequency|dose|dosage|tablet|pill|drug|treatment/i.test(message) && /all.*doc|every.*doc|uploaded.*doc|all.*record|every.*record|uploaded.*record/i.test(message)) {
      const records = context.medical_records || [];
      let results = [];
      for (const rec of records) {
        const text = rec.description || rec.extractedText || '';
        // Simple regex to extract medicine and frequency lines
        // (This can be improved for more complex docs)
        const lines = text.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          // Look for lines with medicine and frequency
          if (/\b(mg|mcg|tablet|pill|capsule|chewable|dose|prescribe|administer|give|directions?)\b/i.test(line)) {
            results.push({
              document: rec.title,
              date: rec.date,
              line
            });
          }
        }
      }
      chatHistory.push({ role: 'user', content: message });
      if (results.length > 0) {
        const response = results.map(r => `From document "${r.document}" (${r.date}):\n${r.line}`).join('\n\n');
        chatHistory.push({ role: 'assistant', content: response });
        return res.json({ response });
      } else {
        chatHistory.push({ role: 'assistant', content: 'No prescribed medicines or frequency found in any document.' });
        return res.json({ response: 'No prescribed medicines or frequency found in any document.' });
      }
    }

    // For all other queries, use the LLM as before
    const userMessageContent = { text: message };
    if (attachment) {
      userMessageContent.attachment = true;
    }
    const userContentForAI = [{ type: 'text', text: message }];
    if (attachment) {
      userContentForAI.push({ type: 'image_url', image_url: { url: attachment } });
    }
    const strictPrompt = `You are AniMedi's AI assistant. You must:
- Always use all available data from reminders, medical records, logs, and pet details to answer.
- Cross-reference reminders and medical records for every answer about medications, treatments, or appointments.
- If the user asks for a document's content, reply ONLY with the exact OCR/extracted text, no extra words or summary.
- If there is a mismatch between reminders and prescriptions, point it out clearly.
- Never hallucinate or omit details. If a field is missing, say so explicitly.
- For questions about past events, use the logs table.
- At the start of your answer, summarize all available data if the user asks for a summary.
- If you are unsure, say so and suggest the user check with a veterinarian.
`;
    // Add strictPrompt and contextPrompt to systemMessages (remove appDocsPrompt)
    const systemMessages = [
        {
          role: "system",
        content: strictPrompt + (contextPrompt || '')
      }
    ];

    // Call OpenAI API
    const messages = [
      ...systemMessages,
      { role: 'user', content: message }
    ];

    // Log the actual prompt being sent
    const promptString = JSON.stringify(messages);
    console.log('PROMPT LENGTH (chars):', promptString.length);
    console.log('ACTUAL PROMPT DATA:', JSON.stringify(messages, null, 2).slice(0, 5000));

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.7,
      max_tokens: 800,
    });

    const aiResponse = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';
    // Save to chat history
    chatHistory.push({ role: 'user', content: message });
    chatHistory.push({ role: 'assistant', content: aiResponse });
    res.json({ response: aiResponse });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ response: 'An error occurred while processing your request.' });
  }
});

app.post('/api/generate-tip', async (req, res) => {
  try {
    const { species, petName, ownerName } = req.body;
    if (!species || !petName || !ownerName) {
      return res.status(400).json({ tip: '', error: 'Species, petName, and ownerName are required.' });
    }
    // Compose a more dynamic prompt for OpenAI
    const prompt = `Give a unique, practical, and concise daily health tip for a pet named ${petName} whose owner is ${ownerName}. Do not use the words 'cat', 'dog', 'pet', 'animal', or 'species' in the tip. Address the tip as if speaking directly to ${ownerName} about ${petName}. Vary the advice every time.`;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: prompt }],
      temperature: 1.0,
      max_tokens: 60,
    });
    const tip = completion.choices[0]?.message?.content?.trim() || '';
    res.json({ tip });
  } catch (error) {
    console.error('Error generating tip:', error);
    res.status(500).json({ tip: '', error: 'Failed to generate tip.' });
  }
});

app.post('/api/generate-care-guide', async (req, res) => {
  try {
    const { petId, petInfo } = req.body;
    if (!petId || !petInfo) {
      return res.status(400).json({ error: 'petId and petInfo are required.' });
    }
    const prompt = `Create a super detailed, comprehensive, and practical owner's manual for a pet with the following details: ${JSON.stringify(petInfo)}. The manual should be extremely thorough and cover everything an owner needs to know, including but not limited to: nutrition, feeding schedule, exercise, play, training, grooming, hygiene, health monitoring, vaccinations, emergency care, enrichment, seasonal/environmental care, red flags, do's, don'ts, additional tips, breed-specific advice, and any other important information. Each section should have at least 8-10 actionable, specific, and personalized items (with explanations where helpful). Format the response as JSON with these keys: { "summary": string, "nutrition": [ ... ], "exercise": [ ... ], "grooming": [ ... ], "health_monitoring": [ ... ], "emergency_care": [ ... ], "enrichment": [ ... ], "seasonal_care": [ ... ], "red_flags": [ ... ], "dos": [ ... ], "donts": [ ... ], "tips": [ ... ] }. Add a disclaimer at the end: 'This guide is for informational purposes only and does not replace professional veterinary advice.'`;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: prompt }],
      temperature: 1.0,
      max_tokens: 4000,
    });
    let text = completion.choices[0]?.message?.content?.trim() || '';
    // Remove code block markers
    if (text.startsWith('```json')) text = text.replace(/^```json/, '').trim();
    if (text.startsWith('```')) text = text.replace(/^```/, '').trim();
    if (text.endsWith('```')) text = text.replace(/```$/, '').trim();
    let guide = {};
    try {
      guide = JSON.parse(text);
    } catch (e) {
      guide = { error: 'Invalid JSON from OpenAI', raw: text, parseError: e.message };
    }
    // Save to DB
    await supabase
      .from('pets')
      .update({ care_guide: guide })
      .eq('id', petId);
    res.json({ care_guide: guide });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate care guide.' });
  }
});

app.post('/api/generate-health-report', async (req, res) => {
  try {
    const { pet, records, reminders, logs } = req.body;
    if (!pet || !records || !reminders || !logs) {
      return res.status(400).json({ error: 'pet, records, reminders, and logs are required.' });
    }

    // Only send metadata and OCR/extracted text for records, not file data
    const recordsForAI = (records || []).slice(0, 10).map(r => ({
      id: r.id,
      title: r.title,
      date: r.date,
      description: r.description,
      extractedText: r.extractedText,
      type: r.type,
      // Do NOT include files or base64 data
    }));
    const remindersForAI = (reminders || []).slice(0, 10);
    const logsForAI = (logs || []).slice(0, 10);

    // Compose a detailed prompt for OpenAI
    const prompt = `You are a veterinary medical assistant. Generate a comprehensive, chronological medical report for the following pet. The report should include:
- All medical history, past medicines, vaccines, illnesses, issues, etc.
- All reminders (upcoming, overdue, completed), all medical records (with OCR/extracted text), all logs, and all pet profile info.
- A summary of the pet's health, and a section with all raw data (reminders, logs, records) for reference.
- Be detailed, clear, and use professional language. Format the report in sections: Pet Profile, Medical History, Reminders, Medical Records, Logs, Health Summary, and Raw Data Appendix.

Pet Profile:
${JSON.stringify(pet, null, 2)}

Recent Reminders (up to 10, total: ${(reminders || []).length}):
${JSON.stringify(remindersForAI, null, 2)}

Recent Medical Records (up to 10, total: ${(records || []).length}):
${JSON.stringify(recordsForAI, null, 2)}

Recent Logs (up to 10, total: ${(logs || []).length}):
${JSON.stringify(logsForAI, null, 2)}

Return the report as structured JSON with keys: { "summary": string, "medical_history": string, "reminders": string, "records": string, "logs": string, "raw_data": { reminders: any[], records: any[], logs: any[] } }`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.7,
      max_tokens: 3000,
    });
    let text = completion.choices[0]?.message?.content?.trim() || '';
    // Remove code block markers
    if (text.startsWith('```json')) text = text.replace(/^```json/, '').trim();
    if (text.startsWith('```')) text = text.replace(/^```/, '').trim();
    if (text.endsWith('```')) text = text.replace(/```$/, '').trim();
    let report = {};
    try {
      report = JSON.parse(text);
    } catch (e) {
      report = { error: 'Invalid JSON from OpenAI', raw: text, parseError: e.message };
    }

    // Log the AI report and raw data for debugging
    console.log('AI report:', report);
    console.log('Reminders:', reminders);
    console.log('Records:', records);
    console.log('Logs:', logs);

    // Generate PDF
    const doc = new PDFDocument({ margin: 40 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${pet.name || 'pet'}-medical-report.pdf"`);
      res.send(pdfBuffer);
    });

    // --- PDFKit Professional Layout with Branding ---
    const accentColor = '#8B5CF6'; // AniMedi purple
    const headerBg = '#F5F3FF';
    const sectionBg = '#F3F4F6';
    const dividerColor = '#E5E7EB';
    const logoPath = __dirname + '/assets/images/icon.png';

    // Header with logo and title
    doc.rect(0, 0, doc.page.width, 70).fill(headerBg);
    try {
      doc.image(logoPath, doc.page.margins.left, 15, { width: 40, height: 40 });
    } catch (e) {
      // If logo not found, skip
    }
    doc.fillColor(accentColor).fontSize(28).font('Helvetica-Bold').text('AniMedi Health Report', 0, 22, { align: 'center', width: doc.page.width });
    doc.moveDown(2.5);
    doc.fillColor('black');

    // Helper functions
    const sectionSpacing = () => doc.moveDown(1.2);
    const divider = () => { doc.moveDown(0.5); doc.strokeColor(dividerColor).lineWidth(1).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke(); doc.moveDown(0.5); };
    const sectionHeader = (title) => {
      doc.moveDown(0.5);
      doc.rect(doc.page.margins.left, doc.y - 2, doc.page.width - doc.page.margins.left - doc.page.margins.right, 28).fill(sectionBg);
      doc.fillColor(accentColor).fontSize(16).font('Helvetica-Bold').text(title, doc.page.margins.left + 8, doc.y - 24, { continued: false });
      doc.fillColor('black');
      doc.moveDown(0.5);
    };

    // Main sections
    sectionHeader(`Health Summary`);
    doc.fontSize(12).font('Helvetica').text(report.summary && report.summary.trim() ? report.summary : 'No summary available.', { width: 500, ellipsis: true });
    sectionSpacing();
    divider();

    sectionHeader(`Medical History`);
    doc.fontSize(12).font('Helvetica').text(report.medical_history && report.medical_history.trim() ? report.medical_history : 'No medical history available.', { width: 500, ellipsis: true });
    sectionSpacing();
    divider();

    sectionHeader(`Reminders`);
    doc.fontSize(12).font('Helvetica').text(report.reminders && report.reminders.trim() ? report.reminders : 'No reminders available.', { width: 500, ellipsis: true });
    sectionSpacing();
    divider();

    sectionHeader(`Medical Records`);
    doc.fontSize(12).font('Helvetica').text(report.records && report.records.trim() ? report.records : 'No records available.', { width: 500, ellipsis: true });
    sectionSpacing();
    divider();

    sectionHeader(`Logs`);
    doc.fontSize(12).font('Helvetica').text(report.logs && report.logs.trim() ? report.logs : 'No logs available.', { width: 500, ellipsis: true });
    sectionSpacing();
    divider();

    // Raw Data Appendix
    doc.addPage();
    sectionHeader('Raw Data Appendix');
    sectionHeader('Reminders');
    if (reminders && reminders.length > 0) {
      reminders.slice(0, 20).forEach((r, i) => {
        doc.fontSize(10).font('Helvetica-Bold').fillColor(accentColor).text(`${i + 1}. ${r.title || 'Untitled'}`, { indent: 10 });
        doc.fontSize(9).font('Helvetica').fillColor('black').text(`Date: ${r.date || r.due_date || 'N/A'}`, { indent: 20 });
        if (r.description) doc.fontSize(9).font('Helvetica').text(`Details: ${r.description}`, { indent: 20 });
        doc.moveDown(0.5);
      });
    } else {
      doc.fontSize(10).font('Helvetica').text('No reminders available.', { indent: 10 });
    }
    sectionSpacing();
    divider();

    sectionHeader('Medical Records');
    if (records && records.length > 0) {
      records.slice(0, 20).forEach((r, i) => {
        doc.fontSize(10).font('Helvetica-Bold').fillColor(accentColor).text(`${i + 1}. ${r.title || 'Untitled'}`, { indent: 10 });
        doc.fontSize(9).font('Helvetica').fillColor('black').text(`Date: ${r.date || 'N/A'}`, { indent: 20 });
        if (r.description) doc.fontSize(9).font('Helvetica').text(`Details: ${(r.description || r.extractedText || '').slice(0, 300)}`, { indent: 20 });
        doc.moveDown(0.5);
      });
    } else {
      doc.fontSize(10).font('Helvetica').text('No medical records available.', { indent: 10 });
    }
    sectionSpacing();
    divider();

    sectionHeader('Logs');
    if (logs && logs.length > 0) {
      logs.slice(0, 20).forEach((l, i) => {
        doc.fontSize(10).font('Helvetica-Bold').fillColor(accentColor).text(`${i + 1}. ${l.title || 'Untitled'}`, { indent: 10 });
        doc.fontSize(9).font('Helvetica').fillColor('black').text(`Date: ${l.created_at || 'N/A'}`, { indent: 20 });
        if (l.log_text) doc.fontSize(9).font('Helvetica').text(`Details: ${(l.log_text || '').slice(0, 300)}`, { indent: 20 });
        doc.moveDown(0.5);
      });
    } else {
      doc.fontSize(10).font('Helvetica').text('No logs available.', { indent: 10 });
    }
    sectionSpacing();
    divider();

    // Footer
    doc.fontSize(9).fillColor('#888888').text('This report is generated by AniMedi. For more information, visit https://animedi.pet', doc.page.margins.left, doc.page.height - 40, { align: 'center', width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
    doc.end();
  } catch (error) {
    console.error('Error generating health report:', error);
    res.status(500).json({ error: 'Failed to generate health report.' });
  }
});

app.post('/api/health-score', async (req, res) => {
  try {
    const { petId } = req.body;
    if (!petId) return res.status(400).json({ error: 'petId is required.' });

    // Fetch pet profile
    const { data: pet, error: petError } = await supabase
      .from('pets')
      .select('*')
      .eq('id', petId)
      .single();
    if (petError) throw petError;

    // Fetch last 3 reminders
    const { data: reminders } = await supabase
      .from('reminders')
      .select('*')
      .eq('pet_id', petId)
      .order('due_date', { ascending: false })
      .limit(3);

    // Fetch last 3 logs
    const { data: logs } = await supabase
      .from('logs')
      .select('*')
      .eq('pet_id', petId)
      .order('created_at', { ascending: false })
      .limit(3);

    // Fetch last 1 medical record
    const { data: records } = await supabase
      .from('medical_records')
      .select('*')
      .eq('pet_id', petId)
      .order('date', { ascending: false })
      .limit(1);

    // Compose a compact prompt
    const prompt = `Based on the following pet profile, recent reminders, logs, and medical record, return ONLY a health score as a percentage (0-100) for this pet. Consider if vaccines are up to date, reminders are completed on time, and general health maintenance. Do not return any explanation or text, only the number.\n\nPet: ${JSON.stringify(pet)}\nReminders: ${JSON.stringify(reminders)}\nLogs: ${JSON.stringify(logs)}\nMedicalRecord: ${JSON.stringify(records)}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.2,
      max_tokens: 10,
    });
    let text = completion.choices[0]?.message?.content?.trim() || '';
    // Extract only the number (percentage)
    const match = text.match(/\d{1,3}/);
    const score = match ? Math.min(100, Math.max(0, parseInt(match[0], 10))) : null;
    if (score === null) return res.status(500).json({ error: 'Could not parse health score.' });
    res.json({ score });
    } catch (error) {
    console.error('Error generating health score:', error);
    res.status(500).json({ error: 'Failed to generate health score.' });
  }
});

// Schedule a daily health score update for all pets
cron.schedule('0 2 * * *', async () => {
  try {
    console.log('Running daily health score update...');
    const { data: pets, error } = await supabase.from('pets').select('id');
    if (error) throw error;
    for (const pet of pets) {
      try {
        // Fetch last 3 reminders
        const { data: reminders } = await supabase
          .from('reminders')
          .select('*')
          .eq('pet_id', pet.id)
          .order('due_date', { ascending: false })
          .limit(3);
        // Fetch last 3 logs
        const { data: logs } = await supabase
          .from('logs')
          .select('*')
          .eq('pet_id', pet.id)
          .order('created_at', { ascending: false })
          .limit(3);
        // Fetch last 1 medical record
        const { data: records } = await supabase
          .from('medical_records')
          .select('*')
          .eq('pet_id', pet.id)
          .order('date', { ascending: false })
          .limit(1);
        // Fetch pet profile
        const { data: petProfile } = await supabase
          .from('pets')
          .select('*')
          .eq('id', pet.id)
          .single();
        // Compose prompt
        const prompt = `Based on the following pet profile, recent reminders, logs, and medical record, return ONLY a health score as a percentage (0-100) for this pet. Consider if vaccines are up to date, reminders are completed on time, and general health maintenance. Do not return any explanation or text, only the number.\n\nPet: ${JSON.stringify(petProfile)}\nReminders: ${JSON.stringify(reminders)}\nLogs: ${JSON.stringify(logs)}\nMedicalRecord: ${JSON.stringify(records)}`;
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'system', content: prompt }],
          temperature: 0.2,
          max_tokens: 10,
        });
        let text = completion.choices[0]?.message?.content?.trim() || '';
        const match = text.match(/\d{1,3}/);
        const score = match ? Math.min(100, Math.max(0, parseInt(match[0], 10))) : null;
        if (score !== null) {
          await supabase.from('pets').update({ health_score: score }).eq('id', pet.id);
          console.log(`Updated health score for pet ${pet.id}: ${score}`);
        } else {
          console.warn(`Could not parse health score for pet ${pet.id}`);
        }
      } catch (e) {
        console.error('Error updating health score for pet', pet.id, e);
      }
    }
    console.log('Daily health score update complete.');
  } catch (e) {
    console.error('Error in daily health score cron:', e);
  }
});

// Start the server if not already started
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
}); 